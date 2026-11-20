import { FastifyInstance, FastifyReply } from "fastify";
import "@fastify/cookie";
import { config } from "../config";
import { db, schema } from "../db";
import { and, eq, sql } from "drizzle-orm";
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  storeRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  validateStoredRefreshToken,
  verifyRefreshToken,
  hashToken,
} from "../lib/auth";
import { authMiddleware } from "../middleware/auth";
import { auditLog } from "../lib/audit";
import { applyPasswordReset, claimResetToken } from "../lib/password-reset";
import speakeasy from "speakeasy";
import { randomBytes } from "crypto";
import crypto from "crypto";
import { verifyTurnstile } from "../middleware/turnstile";
import { sendVerificationEmail } from "../lib/email";

import { validatePhoneNumber } from "../lib/phone-validation";
import { validatePasswordStrength } from "../lib/password-validation";
import { sendSmsVerification, checkSmsVerification } from "../lib/sms";
import { decryptTotpSecret } from "../lib/totp-crypto";
import { timingSafeCompare } from "../lib/timing-safe";
import { hashEmailCode, hashVerificationToken, checkStaticCode } from "../lib/code-hash";
import { accountEmailRoutes } from './account-email';
import {
  consumeVerificationToken, describeVerificationToken, isUniqueViolation, ownedByProvenPhone,
  pendingEmail, violatedConstraint,
} from '../lib/email-claims';

// The web app keeps the access token in memory only. The refresh token also goes
// in an httpOnly cookie so a page reload can restore the session without exposing
// it to scripts. Mobile and the extension keep using the refreshToken body field.
const REFRESH_COOKIE = "amma_refresh";
const REFRESH_COOKIE_PATH = "/api/v1/auth";

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
    maxAge: config.JWT_REFRESH_EXPIRES_IN,
  });
}

function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: true, sameSite: "strict", path: REFRESH_COOKIE_PATH });
}

// Requires @fastify/cookie on the instance (server.ts registers it globally).
export async function authRoutes(app: FastifyInstance) {
  await accountEmailRoutes(app);
  // ──────────────────────────────────────────
  // REGISTER
  // ──────────────────────────────────────────
  app.post(
    "/api/v1/auth/register",
    {
      preHandler: verifyTurnstile,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        tags: ["Auth"],
        description:
          "Register a new user account with email and/or phone number. At least one identifier (email or phoneNumber) is required. Returns JWT tokens and user profile.",
        body: {
          type: "object",
          required: ["password"],
          properties: {
            email: {
              type: "string",
              format: "email",
              description: "User email address",
            },
            password: {
              type: "string",
              minLength: 8,
              description: "Password (min 8 characters)",
            },
            phoneNumber: {
              type: "string",
              pattern: "^\\+[1-9]\\d{6,14}$",
              description: "Phone number in E.164 format (e.g. +14155552671)",
            },
            firstName: { type: "string", description: "First name (optional)" },
            lastName: { type: "string", description: "Last name (optional)" },
            turnstileToken: {
              type: "string",
              description: "Cloudflare Turnstile token",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  email: { type: "string", nullable: true },
                  isEmailVerified: { type: "boolean" },
                  phoneNumber: { type: "string", nullable: true },
                  firstName: { type: "string", nullable: true },
                  lastName: { type: "string", nullable: true },
                },
              },
              accessToken: { type: "string" },
              refreshToken: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { email, password, phoneNumber, firstName, lastName } =
        request.body as {
          email?: string;
          password: string;
          phoneNumber?: string;
          firstName?: string;
          lastName?: string;
        };

      // ── Require at least one identifier ──
      if (!email && !phoneNumber) {
        return reply
          .status(400)
          .send({ error: "Email or phone number is required" });
      }

      // ── Validate E.164 phone format if provided ──
      if (phoneNumber && !/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
        return reply.status(400).send({
          error: "Phone number must be in E.164 format (e.g. +14155552671)",
        });
      }

      // ── Check for duplicates ──
      const normalizedEmail = email ? email.toLowerCase().trim() : null;
      if (normalizedEmail) {
        const [existingByEmail] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, normalizedEmail))
          .limit(1);
        if (existingByEmail) {
          return reply.status(409).send({ error: "Email already registered" });
        }
      }

      if (phoneNumber) {
        const [existingByPhone] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.phoneNumber, phoneNumber))
          .limit(1);
        if (existingByPhone) {
          return reply
            .status(409)
            .send({ error: "Phone number already registered" });
        }
      }

      // ── Validate password strength ──
      const pwCheck = validatePasswordStrength(password);
      if (!pwCheck.valid) {
        return reply.status(400).send({ error: pwCheck.error });
      }

      // ── Create user ──
      const passwordHash = await hashPassword(password);

      let newUser: typeof schema.users.$inferSelect;
      try {
        [newUser] = await db
          .insert(schema.users)
          .values({
            email: normalizedEmail,
            phoneNumber: phoneNumber || null,
            passwordHash,
            firstName: firstName || null,
            lastName: lastName || null,
          })
          .returning();
      } catch (error) {
        // Concurrent registrations pass the checks above; the unique indexes decide.
        if (isUniqueViolation(error)) {
          return reply.status(409).send({
            error: violatedConstraint(error).includes("phone")
              ? "Phone number already registered"
              : "Email already registered",
          });
        }
        throw error;
      }

      // ── Generate tokens ──

      const accessToken = generateAccessToken({
        userId: newUser.id,
        email: newUser.email,
      });
      const refreshToken = generateRefreshToken({
        userId: newUser.id,
        email: newUser.email,
      });
      await storeRefreshToken(newUser.id, refreshToken);
      await auditLog("register", {
        userId: newUser.id,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        detail: {
          email: newUser.email || null,
          phone: newUser.phoneNumber || null,
        },
      });

      // ── Send verification email if email provided ──
      if (email) {
        try {
          const verifyToken = randomBytes(32).toString("hex");
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
          await db.execute(
            sql`INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (${newUser.id}, ${hashVerificationToken(verifyToken)}, ${expiresAt})`,
          );
          await sendVerificationEmail(newUser.email!, verifyToken);
        } catch (err: any) {
          request.log.error({ err: err.message }, "[register] Failed to send verification email");
          // Non-fatal — user is still registered
        }
      }

      setRefreshCookie(reply, refreshToken);
      return reply.send({
        user: {
          id: newUser.id,
          email: newUser.email,
          isEmailVerified: newUser.isEmailVerified ?? false,
          phoneNumber: newUser.phoneNumber,
          firstName: newUser.firstName,
          lastName: newUser.lastName,
        },
        accessToken,
        refreshToken,
      });
    },
  );

  // ──────────────────────────────────────────
  // LOGIN
  // ──────────────────────────────────────────
  app.post(
    "/api/v1/auth/login",
    {
      preHandler: verifyTurnstile,
      config: { rateLimit: { max: 10, timeWindow: "5 minutes" } },
      schema: {
        description:
          "Authenticate with email or phone number. If 2FA is enabled, first call returns twoFaRequired:true, then re-call with twoFaToken.",
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["password"],
          properties: {
            email: {
              type: "string",
              format: "email",
              description: "Login with email",
            },
            phoneNumber: {
              type: "string",
              description:
                "Login with phone number (E.164 format, alternative to email)",
            },
            password: { type: "string" },
            turnstileToken: {
              type: "string",
              description: "Cloudflare Turnstile token",
            },
            twoFaToken: {
              type: "string",
              description:
                "6-digit TOTP/email/static code or 8-char backup code (required if 2FA enabled)",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  id: { type: "number" },
                  email: { type: "string", nullable: true },
                  isEmailVerified: { type: "boolean" },
                  phoneNumber: { type: "string", nullable: true },
                  firstName: { type: "string", nullable: true },
                  lastName: { type: "string", nullable: true },
                  avatar: { type: "string", nullable: true },
                  preferredLanguage: { type: "string" },
                  preferredNetwork: { type: "string" },
                },
              },
              accessToken: { type: "string" },
              refreshToken: { type: "string" },
              twoFaRequired: {
                type: "boolean",
                description: "True if 2FA code is needed",
              },
              twoFaMethod: {
                type: "string",
                enum: ["totp", "email", "static"],
                description: "Which 2FA method is active",
              },
              message: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          401: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const { email, phoneNumber, password } = request.body as {
        email?: string;
        phoneNumber?: string;
        password: string;
      };

      // ── Require at least one identifier ──
      if (!email && !phoneNumber) {
        return reply
          .status(400)
          .send({ error: "Email or phone number is required" });
      }

      if (!password) {
        return reply.status(400).send({ error: "Password is required" });
      }

      // ── Look up user by email or phone ──
      let user;
      if (email) {
        [user] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.email, email.toLowerCase().trim()))
          .limit(1);
      } else {
        [user] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.phoneNumber, phoneNumber!))
          .limit(1);
      }

      if (!user) {
        await auditLog("login_failed", {
          userId: undefined,
          ip: request.ip,
          userAgent: request.headers["user-agent"],
          detail: { identifier: email || phoneNumber },
        });
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      // Check account lockout
      const MAX_FAILED_ATTEMPTS = 10;
      const LOCKOUT_MINUTES = 30;
      if (
        user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS &&
        user.lastFailedLogin
      ) {
        const lockoutUntil = new Date(
          new Date(user.lastFailedLogin).getTime() +
            LOCKOUT_MINUTES * 60 * 1000,
        );
        if (new Date() < lockoutUntil) {
          await auditLog("login_locked", { userId: user.id, ip: request.ip, userAgent: request.headers["user-agent"] });
          // WA-08: say when sign-in opens again, and that a password reset works now (it clears the lock).
          return reply.status(423).send({
            error: `Too many wrong passwords. Sign-in is paused until ${lockoutUntil.toISOString().slice(11, 16)} UTC. You can reset your password now.`,
            retryAt: lockoutUntil.toISOString(),
          });
        }
        await db
          .update(schema.users)
          .set({ failedLoginAttempts: 0 })
          .where(eq(schema.users.id, user.id));
        user.failedLoginAttempts = 0;
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        await db
          .update(schema.users)
          .set({
            failedLoginAttempts: sql`${schema.users.failedLoginAttempts} + 1`,
            lastFailedLogin: new Date(),
          })
          .where(eq(schema.users.id, user.id));
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      // ── 2FA check ──
      if (user.twoFaEnabled) {
        const { twoFaToken } = request.body as any;
        const method = user.twoFaMethod || "totp";

        if (!twoFaToken) {
          // For email method, send a code automatically
          if (method === "email" && user.email) {
            const { send2FACode } = await import("../lib/mailer");
            const code = crypto.randomInt(100000, 1000000).toString();
            const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
            await db.insert(schema.emailCodes).values({
              userId: user.id,
              code: hashEmailCode(code),
              type: "login",
              expiresAt,
            });
            await send2FACode(user.email, code);
          }

          return reply.status(200).send({
            twoFaRequired: true,
            twoFaMethod: method,
            message:
              method === "email"
                ? "A verification code has been sent to your email"
                : method === "static"
                  ? "Enter your 6-digit security code"
                  : "Enter the code from your authenticator app",
          });
        }

        const cleanToken = twoFaToken.replace(/\s/g, "");
        let twoFaValid = false;

        if (
          method === "totp" &&
          cleanToken.length === 6 &&
          /^\d+$/.test(cleanToken)
        ) {
          twoFaValid = speakeasy.totp.verify({
            secret: decryptTotpSecret(user.twoFaSecret!),
            encoding: "base32",
            token: cleanToken,
            window: 1,
          });
        } else if (method === "email") {
          const { and: andOp } = await import("drizzle-orm");
          const [emailCode] = await db
            .select()
            .from(schema.emailCodes)
            .where(
              andOp(
                eq(schema.emailCodes.userId, user.id),
                eq(schema.emailCodes.code, hashEmailCode(cleanToken)),
                eq(schema.emailCodes.type, "login"),
                eq(schema.emailCodes.used, false),
              ),
            )
            .limit(1);
          if (emailCode && new Date(emailCode.expiresAt) > new Date()) {
            twoFaValid = true;
            await db
              .update(schema.emailCodes)
              .set({ used: true })
              .where(eq(schema.emailCodes.id, emailCode.id));
          }
        } else if (
          method === "static" &&
          cleanToken.length === 6 &&
          /^\d+$/.test(cleanToken)
        ) {
          const staticCheck = checkStaticCode(user.twoFaStaticCode, cleanToken, user.id);
          if (staticCheck.valid) {
            twoFaValid = true;
            if (staticCheck.upgrade) {
              // Only replaces the very value that was checked, so a code changed or switched off meanwhile is left alone.
              await db.update(schema.users).set({ twoFaStaticCode: staticCheck.upgrade })
                .where(and(eq(schema.users.id, user.id), eq(schema.users.twoFaStaticCode, user.twoFaStaticCode!)));
            }
          }
        }

        // Always allow backup codes as fallback for any method
        if (!twoFaValid && cleanToken.length === 8 && method !== "static") {
          const hashedInput = crypto
            .createHash("sha256")
            .update(cleanToken.toUpperCase())
            .digest("hex");
          const storedCodes: string[] = JSON.parse(
            user.twoFaBackupCodes || "[]",
          );
          const idx = storedCodes.findIndex((c: string) => timingSafeCompare(c, hashedInput));
          if (idx !== -1) {
            twoFaValid = true;
            storedCodes.splice(idx, 1);
            await db
              .update(schema.users)
              .set({ twoFaBackupCodes: JSON.stringify(storedCodes) })
              .where(eq(schema.users.id, user.id));
          }
        }

        if (!twoFaValid) {
          // A wrong second factor counts like a wrong password, so a six digit code cannot be guessed freely (G-06).
          await db
            .update(schema.users)
            .set({
              // Added in the database, so parallel guesses are all counted.
              failedLoginAttempts: sql`${schema.users.failedLoginAttempts} + 1`,
              lastFailedLogin: new Date(),
            })
            .where(eq(schema.users.id, user.id));
          return reply.status(401).send({ error: "Invalid 2FA code" });
        }
      }

      // Reset failed attempts on successful login
      if (user.failedLoginAttempts > 0) {
        await db
          .update(schema.users)
          .set({ failedLoginAttempts: 0, lastFailedLogin: null })
          .where(eq(schema.users.id, user.id));
      }

      // ── Update last login ──
      await db
        .update(schema.users)
        .set({ lastLoginAt: new Date() })
        .where(eq(schema.users.id, user.id));

      const accessToken = generateAccessToken({
        userId: user.id,
        email: user.email,
      });
      const refreshToken = generateRefreshToken({
        userId: user.id,
        email: user.email,
      });
      await storeRefreshToken(user.id, refreshToken);

      await auditLog("login", { userId: user.id, ip: request.ip, userAgent: request.headers["user-agent"] });

      setRefreshCookie(reply, refreshToken);
      return {
        user: {
          id: user.id,
          email: user.email,
          isEmailVerified: user.isEmailVerified,
          phoneNumber: user.phoneNumber,
          firstName: user.firstName,
          lastName: user.lastName,
          avatar: user.avatar,
          preferredLanguage: user.preferredLanguage,
          preferredNetwork: user.preferredNetwork,
        },
        accessToken,
        refreshToken,
      };
    },
  );

  // ──────────────────────────────────────────
  // REFRESH TOKEN
  // ──────────────────────────────────────────
  app.post(
    "/api/v1/auth/refresh",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        description:
          "Exchange a refresh token for a new access/refresh token pair. Old refresh token is revoked. " +
          "Web clients may omit the body and send the amma_refresh cookie with an X-Amma-Refresh: 1 header.",
        tags: ["Auth"],
        body: {
          type: "object",
          nullable: true,
          properties: {
            refreshToken: {
              type: "string",
              description: "Current refresh token (mobile/extension; web uses the cookie)",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
              refreshToken: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          401: { type: "object", properties: { error: { type: "string" } } },
          403: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const bodyToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken;
      const cookieToken = request.cookies?.[REFRESH_COOKIE];
      const fromCookie = !bodyToken && !!cookieToken;
      const refreshToken = bodyToken || cookieToken;

      if (!refreshToken) {
        return reply.status(400).send({ error: "Refresh token required" });
      }
      // A cookie is sent automatically, so require a header a cross-site form cannot set.
      if (fromCookie && request.headers["x-amma-refresh"] !== "1") {
        return reply.status(403).send({ error: "Missing X-Amma-Refresh header" });
      }

      const valid = await validateStoredRefreshToken(refreshToken);
      if (!valid) {
        if (fromCookie) clearRefreshCookie(reply);
        return reply.status(401).send({ error: "Invalid refresh token" });
      }

      try {
        const payload = verifyRefreshToken(refreshToken);

        // Revoke old token, issue new pair
        await revokeRefreshToken(refreshToken);

        const newAccessToken = generateAccessToken({
          userId: payload.userId,
          email: payload.email,
        });
        const newRefreshToken = generateRefreshToken({
          userId: payload.userId,
          email: payload.email,
        });
        await storeRefreshToken(payload.userId, newRefreshToken);

        setRefreshCookie(reply, newRefreshToken);
        return {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        };
      } catch {
        if (fromCookie) clearRefreshCookie(reply);
        return reply.status(401).send({ error: "Invalid refresh token" });
      }
    },
  );

  // ──────────────────────────────────────────
  // LOGOUT
  // ──────────────────────────────────────────
  app.post(
    "/api/v1/auth/logout",
    {
      preHandler: authMiddleware,
      schema: {
        description: "Revoke a refresh token, ending the session.",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          properties: {
            refreshToken: { type: "string" },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.userId;
      const refreshToken = (request.body as { refreshToken?: string } | undefined)?.refreshToken
        || request.cookies?.[REFRESH_COOKIE];
      clearRefreshCookie(reply);
      if (refreshToken) {
        await revokeRefreshToken(refreshToken);
      } else {
        // No specific token provided — revoke all user sessions (P0-1-F10)
        await revokeAllUserTokens(userId);
      }
      await auditLog("logout", { userId, ip: request.ip, userAgent: request.headers["user-agent"] });

      return { ok: true };
    },
  );

  // ──────────────────────────────────────────
  // GET CURRENT USER (protected)
  // ──────────────────────────────────────────
  app.get(
    "/api/v1/auth/me",
    {
      preHandler: authMiddleware,
      schema: {
        description:
          "Get current authenticated user profile with their wallets.",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "number" },
              email: { type: "string", nullable: true },
              pendingEmail: { type: "string", nullable: true },
              isEmailVerified: { type: "boolean" },
              phoneNumber: { type: "string", nullable: true },
              firstName: { type: "string", nullable: true },
              lastName: { type: "string", nullable: true },
              avatar: { type: "string", nullable: true },
              preferredLanguage: { type: "string" },
              preferredNetwork: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
              wallets: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "number" },
                    name: { type: "string" },
                    publicKey: { type: "string" },
                    network: { type: "string" },
                    isActive: { type: "boolean" },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.userId;

      const [user] = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          isEmailVerified: schema.users.isEmailVerified,
          phoneNumber: schema.users.phoneNumber,
          firstName: schema.users.firstName,
          lastName: schema.users.lastName,
          avatar: schema.users.avatar,
          preferredLanguage: schema.users.preferredLanguage,
          preferredNetwork: schema.users.preferredNetwork,
          createdAt: schema.users.createdAt,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      // Get user's wallets
      const wallets = await db
        .select({
          id: schema.userWallets.id,
          name: schema.userWallets.name,
          publicKey: schema.userWallets.publicKey,
          network: schema.userWallets.network,
          isActive: schema.userWallets.isActive,
          createdAt: schema.userWallets.createdAt,
        })
        .from(schema.userWallets)
        .where(and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar")));

      return { ...user, pendingEmail: user.email ? null : await pendingEmail(userId), wallets };
    },
  );

  // ──────────────────────────────────────────
  // UPDATE PROFILE (protected)
  // ──────────────────────────────────────────
  app.patch(
    "/api/v1/auth/profile",
    {
      preHandler: authMiddleware,
      schema: {
        description:
          "Update user profile fields (name, avatar, language, network, phone number).",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          properties: {
            firstName: { type: "string" },
            lastName: { type: "string" },
            avatar: { type: "string" },
            phoneNumber: {
              type: "string",
              pattern: "^\\+[1-9]\\d{6,14}$",
              description: "Update phone number (E.164 format)",
            },
            preferredLanguage: {
              type: "string",
              enum: ["en", "fr", "es", "pt", "zh"],
            },
            preferredNetwork: { type: "string", enum: ["testnet", "mainnet"] },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "number" },
              email: { type: "string", nullable: true },
              isEmailVerified: { type: "boolean" },
              phoneNumber: { type: "string", nullable: true },
              firstName: { type: "string", nullable: true },
              lastName: { type: "string", nullable: true },
              avatar: { type: "string", nullable: true },
              preferredLanguage: { type: "string" },
              preferredNetwork: { type: "string" },
            },
          },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const userId = request.user!.userId;
      const {
        firstName,
        lastName,
        avatar,
        phoneNumber,
        preferredLanguage,
        preferredNetwork,
      } = request.body as any;

      const updates: any = { updatedAt: new Date() };
      if (firstName !== undefined) updates.firstName = firstName;
      if (lastName !== undefined) updates.lastName = lastName;
      if (avatar !== undefined) updates.avatar = avatar;
      if (preferredLanguage !== undefined)
        updates.preferredLanguage = preferredLanguage;
      if (preferredNetwork !== undefined)
        updates.preferredNetwork = preferredNetwork;

      // ── Phone number update with uniqueness check ──
      if (phoneNumber !== undefined) {
        if (phoneNumber && !/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
          return reply
            .status(400)
            .send({ error: "Phone number must be in E.164 format" });
        }
        if (phoneNumber) {
          const [existing] = await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.phoneNumber, phoneNumber))
            .limit(1);
          if (existing && existing.id !== userId) {
            return reply.status(409).send({
              error: "Phone number already in use by another account",
            });
          }
        }
        updates.phoneNumber = phoneNumber || null;
        updates.phoneVerified = false; // Reset verification when phone changes
      }

      const [updated] = await db
        .update(schema.users)
        .set(updates)
        .where(eq(schema.users.id, userId))
        .returning({
          id: schema.users.id,
          email: schema.users.email,
          isEmailVerified: schema.users.isEmailVerified,
          phoneNumber: schema.users.phoneNumber,
          firstName: schema.users.firstName,
          lastName: schema.users.lastName,
          avatar: schema.users.avatar,
          preferredLanguage: schema.users.preferredLanguage,
          preferredNetwork: schema.users.preferredNetwork,
        });

      return updated;
    },
  );

  // ──────────────────────────────────────────
  // CHANGE PASSWORD (protected)
  // ──────────────────────────────────────────
  app.post(
    "/api/v1/auth/change-password",
    {
      preHandler: authMiddleware,
      schema: {
        description:
          "Change user password. Revokes all refresh tokens, forcing re-login on all devices.",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          properties: {
            currentPassword: { type: "string" },
            newPassword: { type: "string", minLength: 8 },
          },
        },
        response: {
          200: { type: "object", properties: { ok: { type: "boolean" } } },
          400: { type: "object", properties: { error: { type: "string" } } },
          401: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const userId = request.user!.userId;
      const { currentPassword, newPassword } = request.body as {
        currentPassword: string;
        newPassword: string;
      };

      if (!currentPassword || !newPassword) {
        return reply.status(400).send({ error: "Invalid passwords" });
      }
      const pwCheck = validatePasswordStrength(newPassword);
      if (!pwCheck.valid) {
        return reply.status(400).send({ error: pwCheck.error });
      }

      const [user] = await db
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      const valid = await verifyPassword(currentPassword, user.passwordHash);
      if (!valid) {
        return reply
          .status(401)
          .send({ error: "Current password is incorrect" });
      }

      const newHash = await hashPassword(newPassword);
      await db
        .update(schema.users)
        .set({ passwordHash: newHash, updatedAt: new Date() })
        .where(eq(schema.users.id, userId));

      // Revoke all refresh tokens (force re-login everywhere)
      await revokeAllUserTokens(userId);

      await auditLog("password_change", { userId, ip: request.ip, userAgent: request.headers["user-agent"] });

      return { ok: true };
    },
  );

  // ──────────────────────────────────────────
  // FORGOT PASSWORD
  // ──────────────────────────────────────────
  app.post(
    "/api/v1/auth/forgot-password",
    {
      config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
      schema: {
        description: "Request a password reset link. Works with email only.",
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["email"],
          properties: {
            email: { type: "string", format: "email" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const { email } = request.body as { email: string };

      if (!email) {
        return reply.status(400).send({ error: "Email is required" });
      }

      // Always return success to prevent email enumeration
      const successResponse = {
        success: true,
        message: "If that email is registered, a reset link has been sent",
      };
      await auditLog("password_reset_request", {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        detail: { email: email || null },
      });

      const [user] = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          isEmailVerified: schema.users.isEmailVerified,
          phoneVerified: schema.users.phoneVerified,
          phoneNumber: schema.users.phoneNumber,
        })
        .from(schema.users)
        .where(eq(schema.users.email, email.toLowerCase().trim()))
        .limit(1);

      // An unproven address must not be able to take over a phone-owned account.
      // Its owner can still reset by SMS.
      if (!user || ownedByProvenPhone(user)) {
        return successResponse;
      }

      try {
        const resetToken = randomBytes(32).toString("hex");
        const resetTokenHash = hashToken(resetToken);
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
        await db.execute(
          sql`INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (${user.id}, ${resetTokenHash}, ${expiresAt})`,
        );

        // Send the unhashed token to the user via email (they need the raw value)
        const { sendPasswordResetEmail } = await import("../lib/email");
        await sendPasswordResetEmail(user.email!, resetToken);
      } catch (err: any) {
        request.log.error({ err: err.message }, "[forgot-password] Error");
        // Still return success to prevent enumeration
      }

      return successResponse;
    },
  );

  // ──────────────────────────────────────────
  // RESET PASSWORD
  // ──────────────────────────────────────────
  app.post(
    "/api/v1/auth/reset-password",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        description: "Reset password using token from forgot-password email.",
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["token", "newPassword"],
          properties: {
            token: { type: "string", description: "Reset token from email" },
            newPassword: { type: "string", minLength: 8 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          500: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const { token, newPassword } = request.body as {
        token: string;
        newPassword: string;
      };

      if (!token || !newPassword) {
        return reply
          .status(400)
          .send({ error: "Valid token and password required" });
      }
      const pwCheck = validatePasswordStrength(newPassword);
      if (!pwCheck.valid) {
        return reply.status(400).send({ error: pwCheck.error });
      }

      try {
        const tokenHash = hashToken(token);
        const result = await db.execute(
          sql`SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token = ${tokenHash} LIMIT 1`,
        );
        const record = (result as any).rows?.[0] || (result as any)[0];

        if (!record) {
          return reply
            .status(400)
            .send({ error: "Invalid or expired reset token" });
        }
        if (record.used_at) {
          return reply
            .status(400)
            .send({ error: "Reset token has already been used" });
        }
        if (new Date(record.expires_at) < new Date()) {
          return reply.status(400).send({ error: "Reset token has expired" });
        }

        // A link mailed before a phone was proven must not take over the account afterwards.
        const [resetUser] = await db
          .select({
            isEmailVerified: schema.users.isEmailVerified,
            phoneVerified: schema.users.phoneVerified,
            phoneNumber: schema.users.phoneNumber,
          })
          .from(schema.users)
          .where(eq(schema.users.id, record.user_id))
          .limit(1);
        if (!resetUser || ownedByProvenPhone(resetUser)) {
          return reply
            .status(400)
            .send({ error: "Invalid or expired reset token" });
        }

        const newHash = await hashPassword(newPassword);
        const userId = Number(record.user_id);
        // WA-08: claim the link and change the password in one transaction. Of two requests with the same link only one
        // gets the claim; the password, lock, other links, sessions and audit row all commit together or not at all.
        const changed = await db.transaction(async (tx) => {
          if (!(await claimResetToken(tx, record.id, userId))) return false;
          await applyPasswordReset(tx, { userId, passwordHash: newHash, method: "email", ip: request.ip, userAgent: request.headers["user-agent"] });
          return true;
        });
        if (!changed) {
          return reply
            .status(400)
            .send({ error: "Reset token has already been used" });
        }
        return {
          success: true,
          message: "Password reset successfully. Please log in.",
        };
      } catch (err: any) {
        request.log.error({ err: err.message }, "[reset-password] Error");
        return reply.status(500).send({ error: "Password reset failed" });
      }
    },
  );

  // ──────────────────────────────────────────
  // VERIFY EMAIL
  // ──────────────────────────────────────────
  app.get(
    "/api/v1/auth/verify-email",
    {
      schema: {
        description:
          "Describe a verification link. Changes nothing; POST the token to confirm.",
        tags: ["Auth"],
        querystring: {
          type: "object",
          required: ["token"],
          properties: {
            token: {
              type: "string",
              description: "64-char hex verification token",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
              requiresConfirmation: { type: "boolean" },
              email: { type: "string" },
              phoneHint: { type: "string", nullable: true },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          500: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const { token } = request.query as { token: string };

      if (!token) {
        return reply.status(400).send({ error: "Token is required" });
      }

      reply.header("Cache-Control", "no-store");
      try {
        const link = await describeVerificationToken(token);
        if (link.status === "invalid") {
          return reply
            .status(400)
            .send({ error: "Invalid verification token" });
        }
        if (link.status === "already") {
          return { success: true, message: "Email already verified" };
        }
        if (link.status === "expired") {
          return reply.status(400).send({
            error: "Verification token has expired. Please request a new one.",
          });
        }
        // success stays false so a page from an older build cannot report a verification.
        return {
          success: false,
          requiresConfirmation: true,
          email: link.email,
          phoneHint: link.phoneHint,
        };
      } catch (err: any) {
        request.log.error({ err: err.message }, "[verify-email] Error");
        return reply.status(500).send({ error: "Verification failed" });
      }
    },
  );

  app.post(
    "/api/v1/auth/verify-email",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        description:
          "Confirm a verification link after the mailbox owner has seen what it does.",
        tags: ["Auth"],
        body: {
          type: "object",
          required: ["token"],
          additionalProperties: false,
          properties: {
            token: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
          500: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const { token } = request.body as { token: string };

      try {
        const result = await consumeVerificationToken(token);
        if (result.status === "invalid") {
          return reply
            .status(400)
            .send({ error: "Invalid verification token" });
        }
        if (result.status === "already") {
          return { success: true, message: "Email already verified" };
        }
        if (result.status === "expired") {
          return reply.status(400).send({
            error: "Verification token has expired. Please request a new one.",
          });
        }
        if (result.status === "conflict") {
          return reply.status(409).send({
            error: "This email could not be added to this account. It may already belong to another account. If it is yours, sign in with it or reset its password.",
          });
        }
        if (result.releasedUserId !== undefined) {
          await auditLog("email_claim_released", {
            userId: result.releasedUserId,
            ip: request.ip,
            userAgent: request.headers["user-agent"],
            detail: { reason: "mailbox_proof" },
          });
        }

        return { success: true, message: "Email verified successfully!" };
      } catch (err: any) {
        request.log.error({ err: err.message }, "[verify-email] Error");
        return reply.status(500).send({ error: "Verification failed" });
      }
    },
  );

  // ──────────────────────────────────────────
  // RESEND VERIFICATION EMAIL
  // ──────────────────────────────────────────
  app.post(
    "/api/v1/auth/resend-verification",
    {
      preHandler: authMiddleware,
      config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
      schema: {
        description:
          "Resend email verification link to the authenticated user.",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
              verificationSent: { type: "boolean" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          500: { type: "object", properties: { error: { type: "string" } } },
          503: { type: "object", properties: {
            success: { type: "boolean" }, verificationSent: { type: "boolean" }, error: { type: "string" },
          } },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const userId = request.user!.userId;

      const [user] = await db
        .select({
          email: schema.users.email,
          isEmailVerified: schema.users.isEmailVerified,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      if (user.isEmailVerified) {
        return { success: true, message: "Email is already verified" };
      }

      reply.header('Cache-Control', 'no-store');
      const verifyToken = randomBytes(32).toString("hex");
      let target: string | null = null;
      try {
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await db.transaction(async tx => {
          // Serialize rotations for this account, including concurrent first-email writes.
          const locked: any = await tx.execute(sql`SELECT email FROM users WHERE id = ${userId} FOR UPDATE`);
          const accountEmail: string | null = (locked.rows ?? locked)[0]?.email ?? null;
          const claim: any = await tx.execute(sql`SELECT email FROM email_verification_tokens
            WHERE user_id = ${userId} AND email IS NOT NULL AND used_at IS NULL AND expires_at > NOW()
            ORDER BY id DESC LIMIT 1`);
          const pending: string | null = (claim.rows ?? claim)[0]?.email ?? null;
          target = accountEmail ?? pending;
          if (!target) return;
          await tx.execute(sql`DELETE FROM email_verification_tokens WHERE user_id = ${userId}`);
          await tx.execute(sql`INSERT INTO email_verification_tokens (user_id, token, expires_at, email) VALUES (${userId}, ${hashVerificationToken(verifyToken)}, ${expiresAt}, ${accountEmail ? null : pending})`);
        });
      } catch {
        request.log.error('[resend-verification] Unable to persist verification token');
        return reply
          .status(500)
          .send({ error: "Failed to send verification email" });
      }
      if (!target) {
        return reply
          .status(400)
          .send({ error: "No email address on this account" });
      }
      let verificationSent = false;
      try { verificationSent = await sendVerificationEmail(target, verifyToken) === true; }
      catch { request.log.warn('[resend-verification] Verification delivery failed'); }
      if (!verificationSent) {
        return reply.status(503).send({success: false, verificationSent: false,
          error: 'Verification email could not be sent. Please retry.'});
      }
      return { success: true, verificationSent: true, message: "Verification email sent" };
    },
  );

  // ── Phone Verification ─────────────────────────────────────

  app.post(
    "/api/v1/auth/send-phone-code",
    {
      schema: {
        tags: ["Auth"],
        description:
          "Send SMS verification code to authenticated user's phone number. Requires SMS to be enabled.",
        body: {
          type: "object" as const,
          properties: {},
        },
        response: {
          200: {
            type: "object" as const,
            properties: {
              success: { type: "boolean" as const },
              message: { type: "string" as const },
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
      preHandler: [authMiddleware],
    },
    async (request: any, reply: FastifyReply) => {
      const userId = request.user!.userId;
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (!user || !user.phoneNumber) {
        return reply.status(400).send({ error: "No phone number on file" });
      }
      if (user.phoneVerified) {
        return reply.status(400).send({ error: "Phone already verified" });
      }
      const result = await sendSmsVerification(user.phoneNumber);
      if (!result.success) {
        return reply
          .status(503)
          .send({ error: result.error || "SMS service unavailable" });
      }
      return { success: true, message: "Verification code sent" };
    },
  );

  app.post(
    "/api/v1/auth/verify-phone",
    {
      schema: {
        tags: ["Auth"],
        description: "Verify phone number with OTP code received via SMS.",
        body: {
          type: "object" as const,
          required: ["code"] as const,
          properties: {
            code: { type: "string" as const, description: "6-digit OTP code" },
          },
        },
        response: {
          200: {
            type: "object" as const,
            properties: {
              success: { type: "boolean" as const },
              message: { type: "string" as const },
            },
          },
          409: {
            type: "object" as const,
            properties: { error: { type: "string" as const } },
          },
        },
        security: [{ bearerAuth: [] }],
      },
      preHandler: [authMiddleware],
    },
    async (request: any, reply: FastifyReply) => {
      const userId = request.user!.userId;
      const body = request.body as { code: string };
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      if (!user || !user.phoneNumber) {
        return reply.status(400).send({ error: "No phone number on file" });
      }
      if (user.phoneVerified) {
        return reply.status(400).send({ error: "Phone already verified" });
      }
      const result = await checkSmsVerification(user.phoneNumber, body.code);
      if (!result.success) {
        return reply
          .status(400)
          .send({ error: result.error || "Invalid code" });
      }
      // The number may change while the code is checked; only the checked one is proven.
      const verified = await db
        .update(schema.users)
        .set({ phoneVerified: true })
        .where(and(eq(schema.users.id, userId), eq(schema.users.phoneNumber, user.phoneNumber)))
        .returning({ id: schema.users.id });
      if (!verified.length) {
        return reply.status(409).send({ error: "Your phone number changed. Verify the new number." });
      }
      return { success: true, message: "Phone number verified" };
    },
  );

  app.post(
    "/api/v1/auth/forgot-password-sms",
    {
      config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
      schema: {
        tags: ["Auth"],
        description:
          "Request password reset via SMS OTP. For users who registered with phone only.",
        body: {
          type: "object" as const,
          required: ["phoneNumber"] as const,
          properties: {
            phoneNumber: {
              type: "string" as const,
              description: "Phone number in E.164 format",
            },
          },
        },
        response: {
          200: {
            type: "object" as const,
            properties: {
              success: { type: "boolean" as const },
              message: { type: "string" as const },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const { phoneNumber } = request.body as { phoneNumber: string };
      const pv = validatePhoneNumber(phoneNumber);
      if (!pv.isValid) {
        // Always return success to prevent enumeration
        return {
          success: true,
          message: "If that number is registered, a code has been sent.",
        };
      }
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.phoneNumber, pv.phoneNumber))
        .limit(1);
      if (!user) {
        return {
          success: true,
          message: "If that number is registered, a code has been sent.",
        };
      }
      const result = await sendSmsVerification(pv.phoneNumber);
      if (!result.success) {
        // Still return success to prevent enumeration
        request.log.error({ err: result.error }, "[auth] SMS forgot-password send failed");
      }
      return {
        success: true,
        message: "If that number is registered, a code has been sent.",
      };
    },
  );

  app.post(
    "/api/v1/auth/reset-password-sms",
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        tags: ["Auth"],
        description:
          "Reset password using SMS OTP code. Phone must be verified first via forgot-password-sms.",
        body: {
          type: "object" as const,
          required: ["phoneNumber", "code", "newPassword"] as const,
          properties: {
            phoneNumber: { type: "string" as const },
            code: {
              type: "string" as const,
              description: "6-digit OTP from SMS",
            },
            newPassword: { type: "string" as const, minLength: 8 },
          },
        },
        response: {
          200: {
            type: "object" as const,
            properties: {
              success: { type: "boolean" as const },
              message: { type: "string" as const },
            },
          },
        },
      },
    },
    async (request, reply: FastifyReply) => {
      const { phoneNumber, code, newPassword } = request.body as {
        phoneNumber: string;
        code: string;
        newPassword: string;
      };
      const pwCheck = validatePasswordStrength(newPassword);
      if (!pwCheck.valid) {
        return reply.status(400).send({ error: pwCheck.error });
      }
      const pv = validatePhoneNumber(phoneNumber);
      if (!pv.isValid) {
        return reply.status(400).send({ error: "Invalid phone number" });
      }
      // Verify the OTP code
      const check = await checkSmsVerification(pv.phoneNumber, code);
      if (!check.success) {
        return reply
          .status(400)
          .send({ error: check.error || "Invalid or expired code" });
      }
      // Find user
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.phoneNumber, pv.phoneNumber))
        .limit(1);
      if (!user) {
        return reply.status(400).send({ error: "User not found" });
      }
      // Hash new password
      const bcrypt = require("bcryptjs");
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      // WA-08: new hash, login lock cleared, other reset links voided, sessions signed out and the audit row, in one transaction.
      await db.transaction((tx) =>
        applyPasswordReset(tx, { userId: user.id, passwordHash: hashedPassword, method: "sms", ip: request.ip, userAgent: request.headers["user-agent"] }),
      );
      // Mark phone as verified (they proved ownership)
      if (!user.phoneVerified) {
        await db
          .update(schema.users)
          .set({ phoneVerified: true })
          .where(eq(schema.users.id, user.id));
      }
      return {
        success: true,
        message:
          "Password has been reset. Please login with your new password.",
      };
    },
  );
}
