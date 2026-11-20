/**
 * SSO routes — AmmaWallet acts as IdP for trusted relying parties (e.g. LMS).
 *
 * Flow:
 *   1. POST /api/v1/sso/token  — logged-in AmmaWallet user requests a one-time
 *      assertion JWT (60 s TTL) to hand off to a relying party.
 *   2. POST /api/v1/sso/verify — relying-party backend exchanges the assertion
 *      for user identity (server-to-server, x-api-key required).
 *
 * Replay prevention: DB-backed JTI blacklist (sso_used_jtis table).
 * Atomic INSERT ensures single-use across all instances.
 */

import { FastifyInstance } from "fastify";
import { db, schema } from "../db";
import { and, desc, eq, lt } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth";
import { requireTenantApiKey, requireScope } from "../middleware/tenant-api-key";
import { config } from "../config";
import { activationOn } from "../lib/activation-flags";
import { pickSsoWalletAddress } from "../lib/sso-wallet-address";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import {
  LEGACY_SSO_AUDIENCE, parseLegacyWhitelist, parseSsoWhitelist, relyingPartyFor,
  stateHash, stateMatches, tenantAudience, windowOpen,
} from "../lib/sso-rp";

/**
 * Try to consume a JTI atomically. Returns true if the JTI was successfully
 * inserted (first use), false if it already exists (replay).
 */
async function consumeJti(jti: string, expiresAt: Date): Promise<boolean> {
  const result = await db
    .insert(schema.ssoUsedJtis)
    .values({ jti, expiresAt })
    .onConflictDoNothing({ target: schema.ssoUsedJtis.jti })
    .returning({ jti: schema.ssoUsedJtis.jti });
  return result.length > 0;
}

/**
 * Clean up expired JTI entries. Called periodically.
 */
async function cleanupExpiredJtis(): Promise<void> {
  await db.delete(schema.ssoUsedJtis).where(
    lt(schema.ssoUsedJtis.expiresAt, new Date()),
  );
}

// Periodic cleanup — every 5 minutes, remove expired JTI rows
const jtiCleanupTimer = setInterval(() => {
  cleanupExpiredJtis().catch(() => {}); // best-effort
}, 5 * 60_000);
jtiCleanupTimer.unref();

export async function ssoRoutes(app: FastifyInstance) {
  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/v1/sso/token
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/sso/token",
    {
      preHandler: authMiddleware,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["SSO"],
        description:
          "Issue a one-time SSO assertion JWT for the authenticated user. Called by the " +
          "AmmaWallet frontend after login, during an SSO redirect flow.",
        body: {
          type: "object",
          required: ["callbackUrl", "state"],
          properties: {
            callbackUrl: { type: "string", description: "Relying-party callback URL" },
            state:       { type: "string", description: "State token from initiating RP" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!config.SSO_SECRET) {
        app.log.error("[sso/token] SSO_SECRET is not configured");
        return reply.status(503).send({ error: "SSO not configured on this server" });
      }

      const { callbackUrl, state } = request.body as {
        callbackUrl: string;
        state: string;
      };

      // Validate callback URL against whitelist (fail-closed: empty = reject all).
      // WA-05: with SSO_AUDIENCE_ENFORCE on, each entry must be origin=tenantId. Off (default) keeps the old reading, so bare origins still work.
      const enforce = config.SSO_AUDIENCE_ENFORCE;
      const rps: { origin: string; tenantId: number | null }[] = enforce
        ? parseSsoWhitelist(config.SSO_CALLBACK_WHITELIST)
        : parseLegacyWhitelist(config.SSO_CALLBACK_WHITELIST);
      if (enforce && rps.length < config.SSO_CALLBACK_WHITELIST.length) {
        app.log.error("[sso/token] SSO_CALLBACK_WHITELIST has entries that are not origin=tenantId; they are ignored");
      }
      if (enforce ? rps.length === 0 : config.SSO_CALLBACK_WHITELIST.length === 0) {
        app.log.error("[sso/token] No usable SSO_CALLBACK_WHITELIST entry — rejecting all callbacks (fail-closed)");
        return reply.status(403).send({ error: "SSO callback whitelist not configured" });
      }
      let parsedCallback: URL;
      try {
        parsedCallback = new URL(callbackUrl);
      } catch {
        return reply.status(400).send({ error: "Invalid callback URL" });
      }
      const rp = relyingPartyFor(parsedCallback, rps);
      if (!rp) {
        app.log.warn(`[sso/token] Rejected callback URL not in whitelist: ${parsedCallback.origin}`);
        return reply.status(403).send({ error: "Callback URL not in SSO whitelist" });
      }

      const userId = request.user!.userId;

      // Fetch minimal user info for assertion claims
      const [user] = await db
        .select({
          id:              schema.users.id,
          email:           schema.users.email,
          firstName:       schema.users.firstName,
          lastName:        schema.users.lastName,
          isEmailVerified: schema.users.isEmailVerified,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      if (!user) {
        return reply.status(404).send({ error: "User not found" });
      }

      // The mainnet Stellar address for the partner: the Amma-held (index 0) wallet if there is one, else the newest active one.
      const walletRows = await db
        .select({
          publicKey: schema.userWallets.publicKey,
          isActive: schema.userWallets.isActive,
          derivationIndex: schema.userWallets.derivationIndex,
          createdAt: schema.userWallets.createdAt,
        })
        .from(schema.userWallets)
        .where(
          and(
            and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.chain, "stellar")),
            eq(schema.userWallets.network, "public"),
          ),
        )
        .orderBy(desc(schema.userWallets.createdAt))
        .limit(50);

      const mainnetWalletAddress = pickSsoWalletAddress(walletRows);

      // Create one-time assertion JWT — very short TTL, single-use via JTI
      const jti = crypto.randomUUID();
      // Off (default): exactly the pre-WA-05 claims. On: tenant audience, callback origin, state hash; the LMS tenant also keeps the old audience during its dated window.
      let tokenBinding: Record<string, unknown> = { aud: LEGACY_SSO_AUDIENCE };
      if (enforce && rp.tenantId !== null) {
        const legacy = windowOpen(config.SSO_LEGACY_AUD_UNTIL) && rp.tenantId === config.SSO_LEGACY_AUD_TENANT_ID;
        tokenBinding = {
          aud: legacy ? [tenantAudience(rp.tenantId), LEGACY_SSO_AUDIENCE] : tenantAudience(rp.tenantId),
          cbo: rp.origin,
          sth: stateHash(state),
        };
      }
      const assertion = jwt.sign(
        {
          sub:             String(userId),
          email:           user.email,
          firstName:       user.firstName,
          lastName:        user.lastName,
          isEmailVerified: user.isEmailVerified ?? false,
          ...(mainnetWalletAddress !== null && { mainnetWalletAddress }),
          iss:             "ammawallet",
          ...tokenBinding,
          jti,
        },
        config.SSO_SECRET,
        { expiresIn: 60 }, // 60 seconds
      );

      app.log.info(
        `[sso/token] Issued assertion jti=${jti} userId=${userId} hasWallet=${mainnetWalletAddress !== null}${enforce ? ` tenant=${rp.tenantId}` : ""}`,
      );
      return reply.send({ assertionToken: assertion });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/v1/sso/verify
  // ──────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/sso/verify",
    {
      preHandler: [requireTenantApiKey, requireScope("sso:verify")],
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["SSO"],
        description:
          "Verify a one-time SSO assertion token. Called server-to-server by a relying party. " +
          "Requires x-api-key header with sso:verify scope. Each assertion may be verified exactly once.",
        body: {
          type: "object",
          required: ["assertion"],
          properties: {
            assertion: { type: "string", description: "Assertion JWT from /api/v1/sso/token" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!config.SSO_SECRET) {
        return reply.status(503).send({ error: "SSO not configured" });
      }

      // API key authentication is handled by requireTenantApiKey preHandler.
      const ctx = request.tenantApiKeyContext;
      const enforce = config.SSO_AUDIENCE_ENFORCE;
      const { assertion, state } = request.body as { assertion: string; state?: unknown };
      // The state limits apply only when enforcing; off keeps the old schema (any extra body field is ignored).
      if (enforce && state !== undefined && (typeof state !== "string" || state.length > 4096)) {
        return reply.status(400).send({ error: "state must be a string of at most 4096 characters" });
      }

      let audiences: [string, ...string[]];
      let legacyStateExempt = false;
      if (!enforce) {
        // Pre-WA-05 behaviour: any valid key, old audience; the tenant audience too when the key has a tenant. Env keys are logged so the deployer can see which key reaches /verify.
        audiences = [LEGACY_SSO_AUDIENCE];
        if (ctx?.source === "db" && ctx.tenantId !== null) audiences.push(tenantAudience(ctx.tenantId));
        else if (ctx?.source === "env") app.log.warn("[sso/verify] Env API key used (SSO_AUDIENCE_ENFORCE is off)");
      } else {
        // Only a DB-backed tenant key can redeem: env keys have no tenant and skip scope checks (WA-05).
        // D1 option B: while SSO_ENV_KEY_UNTIL is open, an env key counts as the LMS tenant and every use is logged.
        let tenantId: number;
        if (ctx && ctx.source === "db" && ctx.tenantId !== null) {
          tenantId = ctx.tenantId;
        } else if (ctx && ctx.source === "env" && config.SSO_LEGACY_AUD_TENANT_ID > 0 && windowOpen(config.SSO_ENV_KEY_UNTIL)) {
          tenantId = config.SSO_LEGACY_AUD_TENANT_ID;
          app.log.warn(`[sso/verify] Env API key used under the WA-05 window (until ${config.SSO_ENV_KEY_UNTIL}) tenant=${tenantId}`);
        } else {
          return reply.status(403).send({ error: "SSO verify needs a tenant API key" });
        }
        const legacyOpen = windowOpen(config.SSO_LEGACY_AUD_UNTIL);
        const isLegacyTenant = tenantId === config.SSO_LEGACY_AUD_TENANT_ID;
        legacyStateExempt = legacyOpen && isLegacyTenant;
        audiences = legacyStateExempt ? [tenantAudience(tenantId), LEGACY_SSO_AUDIENCE] : [tenantAudience(tenantId)];
      }

      try {
        // Audience is checked here, before the JTI is consumed, so another tenant cannot burn this assertion.
        const payload = jwt.verify(assertion, config.SSO_SECRET, {
          issuer:   "ammawallet",
          audience: audiences,
        }) as jwt.JwtPayload & {
          sub:                  string;
          email:                string;
          firstName:            string | null;
          lastName:             string | null;
          isEmailVerified:      boolean;
          mainnetWalletAddress: string | undefined;
          jti:                  string;
          sth?:                 string;
        };

        if (enforce && typeof payload.sth === "string") {
          if (state === undefined) {
            if (!legacyStateExempt) return reply.status(400).send({ error: "state is required" });
            app.log.warn(`[sso/verify] LMS verified without state jti=${payload.jti}`);
          } else if (!stateMatches(state as string, payload.sth)) {
            app.log.warn(`[sso/verify] State mismatch jti=${payload.jti}`);
            return reply.status(401).send({ error: "Invalid or expired assertion" });
          }
        }

        // Replay prevention — atomic INSERT (conflict = replay)
        const expiresAt = new Date((payload.exp ?? 0) * 1000);
        const isNew = await consumeJti(payload.jti, expiresAt);
        if (!isNew) {
          app.log.warn(`[sso/verify] Replay attempt jti=${payload.jti}`);
          return reply.status(409).send({ error: "Assertion already used" });
        }

        // The user's own sign-in links them to the partner whose DB key verified it. Only written while task activation is on, so billing and maintenance counts are unchanged when it is off.
        const keyContext = request.tenantApiKeyContext;
        if (activationOn(process.env) && keyContext?.source === "db" && keyContext.tenantId !== null) {
          try {
            await db.insert(schema.tenantUsers)
              .values({ tenantId: keyContext.tenantId, userId: Number(payload.sub), registeredVia: "sso" })
              .onConflictDoNothing();
          } catch {
            app.log.warn(`[sso/verify] Could not record the partner link for jti=${payload.jti}`);
          }
        }

        app.log.info(
          `[sso/verify] OK jti=${payload.jti} userId=${payload.sub}`,
        );

        return reply.send({
          userId:               payload.sub,
          email:                payload.email,
          firstName:            payload.firstName ?? null,
          lastName:             payload.lastName  ?? null,
          isEmailVerified:      payload.isEmailVerified,
          mainnetWalletAddress: payload.mainnetWalletAddress ?? null,
        });
      } catch (err: any) {
        app.log.warn(`[sso/verify] Invalid assertion: ${err.message}`);
        return reply.status(401).send({ error: "Invalid or expired assertion" });
      }
    },
  );
}
