/**
 * Auth route test suite — P4-9-F1
 *
 * Covers critical security paths for all major auth endpoints:
 *   - Register (success, duplicate, missing fields)
 *   - Login (valid, wrong password, non-existent user, 2FA challenge, 2FA with TOTP)
 *   - Refresh token (valid, invalid)
 *   - Logout (authenticated)
 *   - /me (authenticated, unauthenticated)
 *   - Change password (success, wrong current password)
 *   - Forgot password (always 200 — no enumeration)
 *   - Reset password (valid token)
 *   - Verify email (valid token, invalid token)
 *
 * All external dependencies are mocked. No real DB or network calls.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks (must be hoisted before any imports) ────────────────────────

// Shared mock functions for db operations
const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbDelete = vi.fn();
const mockDbExecute = vi.fn();
const mockDbTransaction = vi.fn();

vi.mock("../db", () => ({
  db: {
    select: (...args: any[]) => mockDbSelect(...args),
    insert: (...args: any[]) => mockDbInsert(...args),
    update: (...args: any[]) => mockDbUpdate(...args),
    delete: (...args: any[]) => mockDbDelete(...args),
    execute: (...args: any[]) => mockDbExecute(...args),
    transaction: (...args: any[]) => mockDbTransaction(...args),
  },
  schema: {
    users: {
      id: "id",
      email: "email",
      phoneNumber: "phone_number",
      passwordHash: "password_hash",
      failedLoginAttempts: "failed_login_attempts",
      lastFailedLogin: "last_failed_login",
      twoFaEnabled: "two_fa_enabled",
      twoFaMethod: "two_fa_method",
      twoFaSecret: "two_fa_secret",
      twoFaStaticCode: "two_fa_static_code",
      twoFaBackupCodes: "two_fa_backup_codes",
      isEmailVerified: "is_email_verified",
      firstName: "first_name",
      lastName: "last_name",
      avatar: "avatar",
      preferredLanguage: "preferred_language",
      preferredNetwork: "preferred_network",
      createdAt: "created_at",
    },
    userWallets: {
      id: "id",
      userId: "user_id",
      name: "name",
      publicKey: "public_key",
      network: "network",
      isActive: "is_active",
      createdAt: "created_at",
    },
    refreshTokens: { userId: "user_id", token: "token" },
    emailCodes: {
      id: "id",
      userId: "user_id",
      code: "code",
      type: "type",
      used: "used",
      expiresAt: "expires_at",
    },
    auditLogs: {},
  },
}));

vi.mock("../config", () => ({
  config: {
    JWT_SECRET: "test-jwt-secret",
    JWT_REFRESH_SECRET: "test-jwt-refresh-secret",
    JWT_EXPIRES_IN: 900,
    JWT_REFRESH_EXPIRES_IN: 604800,
    WEB_APP_URL: "http://localhost:5173",
    NODE_ENV: "test",
    TOTP_ENCRYPTION_KEY: "a".repeat(64),
  },
}));

vi.mock("../lib/auth", () => {
  const crypto = require("crypto");
  return {
    hashPassword: vi.fn().mockResolvedValue("$2a$12$hashedpassword"),
    verifyPassword: vi.fn().mockResolvedValue(true),
    generateAccessToken: vi.fn().mockReturnValue("mock-access-token"),
    generateRefreshToken: vi.fn().mockReturnValue("mock-refresh-token"),
    storeRefreshToken: vi.fn().mockResolvedValue(undefined),
    revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
    revokeAllUserTokens: vi.fn().mockResolvedValue(undefined),
    validateStoredRefreshToken: vi.fn().mockResolvedValue(true),
    verifyRefreshToken: vi.fn().mockReturnValue({ userId: 42, email: "user@example.com" }),
    hashToken: (token: string) => crypto.createHash("sha256").update(token).digest("hex"),
  };
});

// authMiddleware: by default injects request.user (authenticated)
const mockAuthMiddlewareImpl = vi.fn().mockImplementation(async (request: any) => {
  request.user = { userId: 42, email: "user@example.com" };
});

vi.mock("../middleware/auth", () => ({
  authMiddleware: (...args: any[]) => mockAuthMiddlewareImpl(...args),
}));

vi.mock("../middleware/turnstile", () => ({
  verifyTurnstile: vi.fn().mockImplementation(async () => {}),
}));

vi.mock("../lib/email", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/mailer", () => ({
  send2FACode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/phone-validation", () => ({
  validatePhoneNumber: vi.fn().mockReturnValue({ isValid: true, phoneNumber: "+1234567890" }),
}));

vi.mock("../lib/sms", () => ({
  sendSmsVerification: vi.fn().mockResolvedValue({ success: true }),
  checkSmsVerification: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("../lib/totp-crypto", () => ({
  decryptTotpSecret: vi.fn().mockImplementation((s: string) => s),
  encryptTotpSecret: vi.fn().mockImplementation((s: string) => s),
}));

vi.mock("speakeasy", () => ({
  default: {
    generateSecret: vi.fn().mockReturnValue({ base32: "MOCKSECRET" }),
    totp: {
      verify: vi.fn().mockReturnValue(true),
    },
    otpauthUrl: vi.fn().mockReturnValue("otpauth://totp/mock"),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ col, val }),
  and: (...args: any[]) => ({ and: args }),
  or: (...args: any[]) => ({ or: args }),
  sql: new Proxy(
    (strings: TemplateStringsArray, ...values: any[]) => ({ sql: strings.join("?"), values }),
    { get: (_, prop) => prop === "append" ? vi.fn() : undefined }
  ),
}));

vi.mock("../lib/docker-secrets", () => ({
  resolveDatabaseUrl: vi.fn().mockReturnValue("postgresql://test:test@localhost:5432/test"),
}));

// ── App import (after mocks) ──────────────────────────────────────────────────

import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { authRoutes } from "./auth";
import { sendVerificationEmail } from '../lib/email';
import { hashVerificationToken } from '../lib/code-hash';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build and register a fresh Fastify instance for each describe block */
async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(authRoutes);
  await app.ready();
  return app;
}

/** Default mock user returned by db.select().from().where().limit() */
const mockUser = {
  id: 42,
  email: "user@example.com",
  phoneNumber: "+1234567890",
  passwordHash: "$2a$12$hashedpassword",
  firstName: "Test",
  lastName: "User",
  avatar: null,
  preferredLanguage: "en",
  preferredNetwork: "mainnet",
  createdAt: new Date().toISOString(),
  failedLoginAttempts: 0,
  lastFailedLogin: null,
  twoFaEnabled: false,
  twoFaMethod: null,
  twoFaSecret: null,
  twoFaStaticCode: null,
  twoFaBackupCodes: null,
  isEmailVerified: true,
};

/** Helper: set up db.select chain to return given rows */
function mockSelectReturns(rows: any[]) {
  const mockLimit = vi.fn().mockResolvedValue(rows);
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  mockDbSelect.mockReturnValue({ from: mockFrom });
  return { mockLimit, mockWhere, mockFrom };
}

/** Helper: set up db.select chain for two sequential calls with different results */
function mockSelectSequence(...sequences: any[][]) {
  let callIdx = 0;
  mockDbSelect.mockImplementation(() => {
    const rows = sequences[Math.min(callIdx++, sequences.length - 1)];
    const mockLimit = vi.fn().mockResolvedValue(rows);
    const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere, limit: mockLimit });
    // Also handle .from().where() without .limit() for wallets query
    mockFrom.mockReturnValue({
      where: vi.fn().mockResolvedValue(rows).mockReturnValue({ limit: mockLimit }),
      limit: mockLimit,
    });
    return { from: mockFrom };
  });
}

/** Helper: set up db.update chain */
function mockUpdateSuccess() {
  const mockWhere = vi.fn().mockResolvedValue(undefined);
  const mockReturning = vi.fn().mockResolvedValue([mockUser]);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere, returning: mockReturning });
  mockDbUpdate.mockReturnValue({ set: mockSet });
  return { mockSet, mockWhere };
}

/** Helper: set up db.insert chain */
function mockInsertSuccess(returnedRow: any) {
  const mockReturning = vi.fn().mockResolvedValue([returnedRow]);
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  mockDbInsert.mockReturnValue({ values: mockValues });
  return { mockValues, mockReturning };
}

describe('Auth routes — verification delivery recovery', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let tokens: string[];
  let insertionFails: boolean;
  let accountEmail: string | null;
  beforeEach(async () => {
    vi.clearAllMocks();
    tokens = ['previous-valid-token']; insertionFails = false; accountEmail = mockUser.email;
    mockSelectReturns([{...mockUser, isEmailVerified: false}]);
    mockDbExecute.mockImplementation(async statement => {
      if (statement.sql.includes('SELECT email FROM users')) return {rows: [{email: accountEmail}]};
      if (statement.sql.includes('DELETE FROM email_verification_tokens')) tokens = [];
      if (statement.sql.includes('INSERT INTO email_verification_tokens')) {
        if (insertionFails) throw new Error('synthetic persistence failure');
        tokens.push(statement.values[1]);
      }
      return {rows: []};
    });
    mockDbTransaction.mockImplementation(async work => {
      const previous = [...tokens];
      try { return await work({execute: mockDbExecute}); }
      catch (error) { tokens = previous; throw error; }
    });
    vi.mocked(sendVerificationEmail).mockResolvedValue(true);
    app = await buildApp();
  });
  async function resend() {
    const response = await app.inject({method: 'POST', url: '/api/v1/auth/resend-verification'});
    await app.close(); return response;
  }
  it('reports delivery only after committing a fresh verification token', async () => {
    const response = await resend();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({success: true, verificationSent: true});
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    // The mail carries the raw token; the database holds only its keyed hash (G-06).
    const sentToken = vi.mocked(sendVerificationEmail).mock.calls[0][1];
    expect(sentToken).toMatch(/^[a-f0-9]{64}$/);
    expect(sentToken).not.toBe(tokens[0]);
    expect(hashVerificationToken(sentToken)).toBe(tokens[0]);
    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
  });
  it.each([false, 'throws'])('does not claim successful delivery when the provider %s', async failure => {
    if (failure === false) vi.mocked(sendVerificationEmail).mockResolvedValue(false);
    else vi.mocked(sendVerificationEmail).mockRejectedValue(new Error('synthetic provider failure'));
    const response = await resend();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({success: false, verificationSent: false});
    expect(response.json().error).toContain('retry');
    expect(tokens).toHaveLength(1); // Persisted retry evidence is retained.
  });
  it('preserves the old usable token when replacement persistence fails', async () => {
    insertionFails = true;
    expect((await resend()).statusCode).toBe(500);
    expect(tokens).toEqual(['previous-valid-token']);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
  it('locks the account before invalidating older tokens', async () => {
    await resend();
    const statements = mockDbExecute.mock.calls.map(([statement]) => statement.sql);
    expect(statements[0]).toContain('FOR UPDATE');
    expect(statements[2]).toContain('DELETE FROM email_verification_tokens');
    expect(statements[3]).toContain('INSERT INTO email_verification_tokens');
  });
  it('does not issue verification tokens for a phone-only account with no pending email', async () => {
    accountEmail = null;
    mockSelectReturns([{...mockUser, email: null, isEmailVerified: false}]);
    expect((await resend()).statusCode).toBe(400);
    expect(tokens).toEqual(['previous-valid-token']);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
  it('does not resend when verification is already complete', async () => {
    mockSelectReturns([mockUser]);
    expect((await resend()).statusCode).toBe(200);
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Auth routes — Register", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("Test 1: Successful registration returns 201 with user data and tokens", async () => {
    // No existing user for duplicate check
    mockSelectReturns([]);
    // Insert returns new user
    mockInsertSuccess({
      id: 1,
      email: "newuser@example.com",
      phoneNumber: null,
      firstName: "New",
      lastName: "User",
    });
    // db.execute for email_verification_tokens INSERT
    mockDbExecute.mockResolvedValue({ rows: [] });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "newuser@example.com",
        password: "SecurePass123!",
        firstName: "New",
        lastName: "User",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("accessToken", "mock-access-token");
    expect(body).toHaveProperty("refreshToken", "mock-refresh-token");
    expect(body.user).toMatchObject({
      id: 1,
      email: "newuser@example.com",
    });
  });

  it("Test 2: Duplicate email returns 409", async () => {
    // Existing user found for email check
    mockSelectReturns([{ id: 99 }]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email: "existing@example.com",
        password: "SecurePass123!",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toHaveProperty("error", "Email already registered");
  });

  it("Test 3: Missing both email and phoneNumber returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        password: "SecurePass123!",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error", "Email or phone number is required");
  });
});

describe("Auth routes — Login", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("Test 4: Valid credentials return access and refresh tokens", async () => {
    mockSelectReturns([mockUser]);
    mockUpdateSuccess(); // for lastLoginAt update

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "user@example.com",
        password: "SecurePass123!",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("accessToken", "mock-access-token");
    expect(body).toHaveProperty("refreshToken", "mock-refresh-token");
    expect(body.user).toMatchObject({ id: 42, email: "user@example.com" });
  });

  it("Test 5: Wrong password returns 401 with generic error", async () => {
    const { verifyPassword } = await import("../lib/auth");
    (verifyPassword as any).mockResolvedValueOnce(false);

    mockSelectReturns([mockUser]);
    mockUpdateSuccess(); // for failedLoginAttempts update

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "user@example.com",
        password: "WrongPassword!",
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error", "Invalid credentials");
  });

  it("Test 5b: A locked account gets 423 with the time sign-in opens again", async () => {
    const lastFailedLogin = new Date(Date.now() - 5 * 60_000);
    mockSelectReturns([{ ...mockUser, failedLoginAttempts: 10, lastFailedLogin }]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "SecurePass123!" },
    });

    expect(res.statusCode).toBe(423);
    const body = res.json();
    const opensAt = new Date(lastFailedLogin.getTime() + 30 * 60_000);
    expect(body.retryAt).toBe(opensAt.toISOString());
    expect(body.error).toBe(`Too many wrong passwords. Sign-in is paused until ${opensAt.toISOString().slice(11, 16)} UTC. You can reset your password now.`);
  });

  it("Test 6: Non-existent user returns 401 — same response as wrong password (no enumeration)", async () => {
    mockSelectReturns([]); // no user found

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "nobody@example.com",
        password: "SomePassword!",
      },
    });

    expect(res.statusCode).toBe(401);
    // Must be IDENTICAL error message to wrong password — no enumeration
    expect(res.json()).toHaveProperty("error", "Invalid credentials");
  });

  it("Test 7: 2FA-enabled user without twoFaToken returns twoFaRequired:true without tokens", async () => {
    const twoFaUser = {
      ...mockUser,
      twoFaEnabled: true,
      twoFaMethod: "totp",
      twoFaSecret: "MOCKSECRET",
    };
    mockSelectReturns([twoFaUser]);
    mockUpdateSuccess(); // lastLoginAt — may not be called here

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "user@example.com",
        password: "SecurePass123!",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.twoFaRequired).toBe(true);
    expect(body.twoFaMethod).toBe("totp");
    // Must NOT include tokens when 2FA challenge is pending
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("refreshToken");
  });

  it("Test 8: 2FA-enabled user with valid TOTP code returns tokens", async () => {
    const speakeasy = await import("speakeasy");
    (speakeasy.default.totp.verify as any).mockReturnValueOnce(true);

    const twoFaUser = {
      ...mockUser,
      twoFaEnabled: true,
      twoFaMethod: "totp",
      twoFaSecret: "MOCKSECRET",
    };
    mockSelectReturns([twoFaUser]);
    mockUpdateSuccess(); // lastLoginAt update

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "user@example.com",
        password: "SecurePass123!",
        twoFaToken: "123456",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("accessToken", "mock-access-token");
    expect(body).toHaveProperty("refreshToken", "mock-refresh-token");
    expect(body).not.toHaveProperty("twoFaRequired");
  });
});

describe("Auth routes — Refresh token", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("Test 9: Valid refresh token returns new token pair", async () => {
    const { validateStoredRefreshToken, verifyRefreshToken } = await import("../lib/auth");
    (validateStoredRefreshToken as any).mockResolvedValueOnce(true);
    (verifyRefreshToken as any).mockReturnValueOnce({ userId: 42, email: "user@example.com" });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: "valid-refresh-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("accessToken", "mock-access-token");
    expect(body).toHaveProperty("refreshToken", "mock-refresh-token");
  });

  it("Test 10: Invalid/expired refresh token returns 401", async () => {
    const { validateStoredRefreshToken } = await import("../lib/auth");
    (validateStoredRefreshToken as any).mockResolvedValueOnce(false);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: "invalid-or-expired-token" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error", "Invalid refresh token");
  });
});

describe("Auth routes — refresh cookie (stay signed in across reloads)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const refreshCookie = (res: any) => res.cookies.find((c: any) => c.name === "amma_refresh");

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("login sets an httpOnly, Secure, SameSite=Strict refresh cookie scoped to the auth routes", async () => {
    mockSelectReturns([mockUser]);
    mockUpdateSuccess();
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/login",
      payload: { email: "user@example.com", password: "SecurePass123!" },
    });
    expect(res.statusCode).toBe(200);
    expect(refreshCookie(res)).toMatchObject({
      value: "mock-refresh-token", httpOnly: true, secure: true, sameSite: "Strict", path: "/api/v1/auth",
    });
    expect(refreshCookie(res).maxAge).toBeGreaterThan(0);
  });

  it("refresh accepts the cookie without a body and rotates it", async () => {
    const { validateStoredRefreshToken, revokeRefreshToken } = await import("../lib/auth");
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/refresh",
      headers: { "x-amma-refresh": "1" },
      cookies: { amma_refresh: "cookie-refresh-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(validateStoredRefreshToken).toHaveBeenCalledWith("cookie-refresh-token");
    expect(revokeRefreshToken).toHaveBeenCalledWith("cookie-refresh-token");
    expect(res.json()).toHaveProperty("accessToken", "mock-access-token");
    expect(refreshCookie(res)).toMatchObject({ value: "mock-refresh-token", httpOnly: true });
  });

  it("refresh from the cookie requires the X-Amma-Refresh header", async () => {
    const { validateStoredRefreshToken } = await import("../lib/auth");
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/refresh",
      cookies: { amma_refresh: "cookie-refresh-token" },
    });
    expect(res.statusCode).toBe(403);
    expect(validateStoredRefreshToken).not.toHaveBeenCalled();
  });

  it("refresh with neither a body token nor a cookie returns 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", headers: { "x-amma-refresh": "1" } });
    expect(res.statusCode).toBe(400);
  });

  it("a rejected cookie is cleared", async () => {
    const { validateStoredRefreshToken } = await import("../lib/auth");
    (validateStoredRefreshToken as any).mockResolvedValueOnce(false);
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/refresh",
      headers: { "x-amma-refresh": "1" },
      cookies: { amma_refresh: "revoked-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(refreshCookie(res)).toMatchObject({ value: "", path: "/api/v1/auth" });
  });

  it("logout revokes the cookie's token and clears the cookie", async () => {
    const { revokeRefreshToken, revokeAllUserTokens } = await import("../lib/auth");
    const res = await app.inject({
      method: "POST", url: "/api/v1/auth/logout",
      headers: { authorization: "Bearer mock-access-token" },
      cookies: { amma_refresh: "cookie-refresh-token" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(revokeRefreshToken).toHaveBeenCalledWith("cookie-refresh-token");
    expect(revokeAllUserTokens).not.toHaveBeenCalled();
    expect(refreshCookie(res)).toMatchObject({ value: "", path: "/api/v1/auth" });
  });
});

describe("Auth routes — Logout", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("Test 11: Authenticated logout returns 200 ok:true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { authorization: "Bearer mock-access-token" },
      payload: { refreshToken: "some-refresh-token" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("ok", true);
  });
});

describe("Auth routes — /me", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("Test 12: Returns user profile for authenticated user", async () => {
    // Two selects: one for user, one for wallets
    let callCount = 0;
    mockDbSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // User select with .limit()
        const mockLimit = vi.fn().mockResolvedValue([mockUser]);
        const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
        return { from: mockFrom };
      } else {
        // Wallets select without .limit()
        const mockWhere = vi.fn().mockResolvedValue([]);
        const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
        return { from: mockFrom };
      }
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: "Bearer mock-access-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("id", 42);
    expect(body).toHaveProperty("email", "user@example.com");
    expect(body).toHaveProperty("wallets");
    expect(body.isEmailVerified).toBe(true);
  });

  it("Test 13: Returns 401 without auth token (no Authorization header)", async () => {
    // Override authMiddleware to reject (no auth header provided, real check fires)
    mockAuthMiddlewareImpl.mockImplementationOnce(async (request: any, reply: any) => {
      return reply.status(401).send({ error: "No token provided" });
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      // No Authorization header
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error");
  });
});

describe("Auth routes — Change password", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("Test 14: Successful password change returns 200 ok:true", async () => {
    const { verifyPassword } = await import("../lib/auth");
    (verifyPassword as any).mockResolvedValueOnce(true);

    mockSelectReturns([{ passwordHash: "$2a$12$currenthash" }]);
    mockUpdateSuccess();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { authorization: "Bearer mock-access-token" },
      payload: {
        currentPassword: "CurrentPass123!",
        newPassword: "NewSecurePass456!",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("ok", true);
  });

  it("Test 15: Wrong current password returns 401", async () => {
    const { verifyPassword } = await import("../lib/auth");
    (verifyPassword as any).mockResolvedValueOnce(false);

    mockSelectReturns([{ passwordHash: "$2a$12$currenthash" }]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { authorization: "Bearer mock-access-token" },
      payload: {
        currentPassword: "WrongCurrentPass!",
        newPassword: "NewSecurePass456!",
      },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error", "Current password is incorrect");
  });
});

describe("Auth routes — Forgot password", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("Test 16: Always returns 200 even for unregistered email (no enumeration)", async () => {
    // No user found — must still return 200
    mockSelectReturns([]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "nobody@example.com" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("If that email is registered");
  });

  it("Test 16b: Returns 200 for registered email too (same response — no enumeration)", async () => {
    mockSelectReturns([{ id: 42, email: "user@example.com" }]);
    // db.execute for INSERT INTO password_reset_tokens
    mockDbExecute.mockResolvedValue({ rows: [] });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "user@example.com" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // Response must be IDENTICAL — attacker cannot distinguish registered from unregistered
    expect(body.message).toContain("If that email is registered");
  });
});

describe("Auth routes — Reset password", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbTransaction.mockImplementation(async (work) => work({ execute: mockDbExecute }));
    app = await buildApp();
  });

  it("Test 17: Valid reset token and new password returns 200", async () => {
    // db.execute for SELECT from password_reset_tokens returns a valid record
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          user_id: 42,
          expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
          used_at: null,
        },
      ],
    });
    // The account is not owned by a proven phone
    mockSelectReturns([{ isEmailVerified: true, phoneVerified: false, phoneNumber: null }]);
    // In the transaction: the claim returns its row, then the reset writes
    mockDbExecute.mockResolvedValueOnce({ rows: [{ id: 42 }] }); // lock the user
    mockDbExecute.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // claim the link
    mockDbExecute.mockResolvedValue({ rows: [] });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: {
        token: "valid-reset-token-hex",
        newPassword: "BrandNewPass456!",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("Password reset successfully");
    // One transaction: claim the link, password and lock, other links, refresh tokens, OAuth tokens, audit row
    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
    const statements = mockDbExecute.mock.calls.slice(1).map(([q]) => JSON.stringify(q.queryChunks ?? q));
    expect(statements[0]).toContain("FOR UPDATE");
    expect(statements[1]).toContain("UPDATE password_reset_tokens SET used_at = NOW()");
    expect(statements[1]).toContain("RETURNING id");
    expect(statements[2]).toContain("failed_login_attempts = 0");
    expect(statements[2]).toContain("last_failed_login = NULL");
    expect(statements.join("")).toContain("DELETE FROM refresh_tokens");
    expect(statements.join("")).toContain("UPDATE token_registry SET revoked_at");
    expect(statements.at(-1)).toContain("INSERT INTO audit_logs");
    // The shared helper that logout and change-password use is not part of the reset
    const { revokeAllUserTokens } = await import("../lib/auth");
    expect(revokeAllUserTokens).not.toHaveBeenCalled();
  });

  it("Test 17c: A reset link another request already claimed returns 400 and changes nothing", async () => {
    mockDbExecute.mockResolvedValueOnce({
      rows: [{ id: 1, user_id: 42, expires_at: new Date(Date.now() + 3600000).toISOString(), used_at: null }],
    });
    mockSelectReturns([{ isEmailVerified: true, phoneVerified: false, phoneNumber: null }]);
    mockDbExecute.mockResolvedValueOnce({ rows: [{ id: 42 }] }); // lock the user
    mockDbExecute.mockResolvedValueOnce({ rows: [] }); // the claim finds the link already used

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: "valid-reset-token-hex", newPassword: "BrandNewPass456!" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error", "Reset token has already been used");
    expect(mockDbExecute).toHaveBeenCalledTimes(3); // the lookup, the user lock and the claim, nothing else
  });

  it("Test 17b: Invalid reset token returns 400", async () => {
    // db.execute for SELECT returns no record
    mockDbExecute.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: {
        token: "invalid-or-expired-token",
        newPassword: "BrandNewPass456!",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error", "Invalid or expired reset token");
  });
});

describe("Auth routes — Verify email", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbTransaction.mockImplementation(async (work) => work({ execute: mockDbExecute }));
    app = await buildApp();
  });

  it("Test 18: Valid token marks email as verified and returns 200", async () => {
    // Token lookup, then the account and token locks
    mockDbExecute.mockResolvedValueOnce({ rows: [{ user_id: 42 }] });
    mockDbExecute.mockResolvedValueOnce({ rows: [{ email: "user@example.com" }] });
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          email: null,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          used_at: null,
        },
      ],
    });
    // UPDATE users, then UPDATE email_verification_tokens SET used_at = NOW()
    mockDbExecute.mockResolvedValueOnce({ rows: [] });
    mockDbExecute.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-email",
      payload: { token: "validtoken123abc" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("verified");
  });

  it("Test 19: Invalid or expired token returns 400", async () => {
    // db.execute for SELECT returns no record
    mockDbExecute.mockResolvedValueOnce({ rows: [] });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/verify-email?token=invalidtoken",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error", "Invalid verification token");
  });

  it("Test 19b: Expired token returns 400 with expiry message", async () => {
    // db.execute for the link lookup returns a record that is expired
    mockDbExecute.mockResolvedValueOnce({
      rows: [
        {
          claim_email: null,
          account_email: "user@example.com",
          expires_at: new Date(Date.now() - 3600000).toISOString(), // expired 1 hour ago
          used_at: null,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/verify-email?token=expiredtoken",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("expired");
  });
});
