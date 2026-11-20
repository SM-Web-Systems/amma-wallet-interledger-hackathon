import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";

const mockConfig = vi.hoisted(() => ({
  SSO_SECRET: "test-sso-secret-at-least-32-chars-long!!",
  SSO_CALLBACK_WHITELIST: [] as string[],
  SSO_AUDIENCE_ENFORCE: false,
  SSO_LEGACY_AUD_UNTIL: "",
  SSO_LEGACY_AUD_TENANT_ID: 0,
  SSO_ENV_KEY_UNTIL: "",
  JWT_SECRET: "test-jwt-secret",
}));
const dbKey = (tenantId: number) => ({ source: "db" as const, tenantId, keyId: tenantId, scopes: ["sso:verify"], rateLimitPerMinute: 60 });
const envKey = { source: "env" as const, tenantId: null, keyId: null, scopes: [] as string[], rateLimitPerMinute: 60 };
const keyCtx = vi.hoisted(() => ({ value: undefined as any }));
const mockIdentity = vi.hoisted(() => ({
  id: 1, email: 'test@example.com' as string | null, firstName: 'Test', lastName: 'User', isEmailVerified: true,
}));

// Track consumed JTIs for the mock DB
const consumedJtis = new Set<string>();

const mockDbInsert = vi.fn();
const mockDbDelete = vi.fn();

vi.mock("../db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () => [mockIdentity]),
          }),
          limit: vi.fn().mockImplementation(async () => [mockIdentity]),
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    insert: (...args: any[]) => mockDbInsert(...args),
    delete: (...args: any[]) => mockDbDelete(...args),
  },
  schema: {
    users: { id: "id", email: "email", firstName: "firstName", lastName: "lastName", isEmailVerified: "isEmailVerified" },
    userWallets: { userId: "userId", publicKey: "publicKey", network: "network", isActive: "isActive", createdAt: "createdAt" },
    ssoUsedJtis: { jti: "jti", usedAt: "used_at", expiresAt: "expires_at" },
  },
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: async (request: any) => {
    request.user = { userId: 1 };
  },
}));

vi.mock("../middleware/tenant-api-key", () => ({
  requireTenantApiKey: vi.fn(async (request: any) => { request.tenantApiKeyContext = keyCtx.value; }),
  requireScope: vi.fn(() => async () => {}),
}));

vi.mock("../config", () => ({
  config: mockConfig,
}));

import Fastify from "fastify";
import { ssoRoutes } from "./sso";
import { createHash } from "node:crypto";

function setupJtiMock() {
  // Simulate INSERT ... ON CONFLICT DO NOTHING ... RETURNING
  mockDbInsert.mockImplementation(() => ({
    values: (val: { jti: string }) => ({
      onConflictDoNothing: () => ({
        returning: () => {
          if (consumedJtis.has(val.jti)) {
            return Promise.resolve([]); // conflict — replay
          }
          consumedJtis.add(val.jti);
          return Promise.resolve([{ jti: val.jti }]); // inserted — first use
        },
      }),
    }),
  }));
  // Mock delete for cleanup
  mockDbDelete.mockReturnValue({
    where: () => Promise.resolve(),
  });
}

describe('LMS verified-email assertion contract', () => {
  beforeEach(() => {
    vi.clearAllMocks(); consumedJtis.clear(); setupJtiMock();
    mockIdentity.email = 'learner@example.invalid'; mockIdentity.isEmailVerified = false;
    mockConfig.SSO_CALLBACK_WHITELIST = ['https://lms.example.invalid'];
  });
  async function issue(app: ReturnType<typeof Fastify>) {
    const response = await app.inject({method: 'POST', url: '/api/v1/sso/token',
      payload: {callbackUrl: 'https://lms.example.invalid/callback', state: 'synthetic-state'}});
    expect(response.statusCode).toBe(200);
    return response.json().assertionToken as string;
  }
  async function verify(app: ReturnType<typeof Fastify>, assertion: string) {
    return app.inject({method: 'POST', url: '/api/v1/sso/verify', payload: {assertion}});
  }
  it.each([null, 'learner@example.invalid'])('preserves incomplete onboarding claims for %s', async email => {
    mockIdentity.email = email;
    const app = Fastify(); app.register(ssoRoutes);
    try {
      const response = await verify(app, await issue(app));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({userId: '1', email, firstName: 'Test', lastName: 'User',
        isEmailVerified: false, mainnetWalletAddress: null});
      // LMS rejects missing/unverified email; Wallet must never infer verification from a session or wallet.
    } finally {await app.close();}
  });
  it('requires a fresh assertion after verification and keeps every assertion single-use', async () => {
    const app = Fastify(); app.register(ssoRoutes);
    try {
      const before = await issue(app);
      mockIdentity.isEmailVerified = true;
      const after = await issue(app);
      expect((await verify(app, before)).json().isEmailVerified).toBe(false);
      const current = await verify(app, after);
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({userId: '1', email: 'learner@example.invalid', isEmailVerified: true, mainnetWalletAddress: null});
      expect((await verify(app, after)).statusCode).toBe(409);
    } finally {await app.close();}
  });
});

describe("SSO routes — callback whitelist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumedJtis.clear();
    mockConfig.SSO_CALLBACK_WHITELIST = [];
    setupJtiMock();
  });

  it("POST /api/v1/sso/token rejects when SSO_CALLBACK_WHITELIST is empty (fail-closed)", async () => {
    const app = Fastify();
    app.register(ssoRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/token",
      headers: { authorization: "Bearer mock-token" },
      payload: {
        callbackUrl: "https://evil.com/callback",
        state: "abc123",
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("whitelist");
  });

  it("POST /api/v1/sso/token allows callback when URL is in whitelist", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.smwebsystems.com"];
    const app = Fastify();
    app.register(ssoRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/token",
      headers: { authorization: "Bearer mock-token" },
      payload: {
        callbackUrl: "https://lms.smwebsystems.com/api/v1/auth/ammaCallback",
        state: "abc123",
      },
    });

    // Should proceed past whitelist check (may fail on DB lookup, but not 403)
    expect(res.statusCode).not.toBe(403);
  });

  it("POST /api/v1/sso/token rejects callback not in whitelist", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.smwebsystems.com"];
    const app = Fastify();
    app.register(ssoRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/token",
      headers: { authorization: "Bearer mock-token" },
      payload: {
        callbackUrl: "https://evil.com/steal",
        state: "abc123",
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("whitelist");
  });

  it("rejects subdomain hijack: lms.smwebsystems.com.evil.com (P1-4-F1)", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.smwebsystems.com"];
    const app = Fastify();
    app.register(ssoRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/token",
      headers: { authorization: "Bearer mock-token" },
      payload: {
        callbackUrl: "https://lms.smwebsystems.com.evil.com/steal",
        state: "abc123",
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("whitelist");
  });

  it("rejects callback with matching prefix but different port", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.smwebsystems.com"];
    const app = Fastify();
    app.register(ssoRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/token",
      headers: { authorization: "Bearer mock-token" },
      payload: {
        callbackUrl: "https://lms.smwebsystems.com:8443/steal",
        state: "abc123",
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects malformed callback URL with 400", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.smwebsystems.com"];
    const app = Fastify();
    app.register(ssoRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/token",
      headers: { authorization: "Bearer mock-token" },
      payload: {
        callbackUrl: "not-a-url",
        state: "abc123",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid callback URL");
  });
});

describe("SSO routes — JTI replay prevention (DB-backed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consumedJtis.clear();
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.smwebsystems.com"];
    setupJtiMock();
  });

  function makeAssertion(overrides: Record<string, unknown> = {}): string {
    return jwt.sign(
      {
        sub: "1",
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
        isEmailVerified: true,
        iss: "ammawallet",
        aud: "lms-amma-sso",
        jti: "test-jti-" + Math.random().toString(36).slice(2),
        ...overrides,
      },
      mockConfig.SSO_SECRET,
      { expiresIn: 60 },
    );
  }

  it("JTI-DB-01: first use of assertion succeeds", async () => {
    const app = Fastify();
    await app.register(ssoRoutes);
    await app.ready();

    const assertion = makeAssertion();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/verify",
      headers: { "x-api-key": "test-key" },
      payload: { assertion },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().userId).toBe("1");
    expect(res.json().email).toBe("test@example.com");
  });

  it("JTI-DB-02: replay of same assertion returns 409", async () => {
    const app = Fastify();
    await app.register(ssoRoutes);
    await app.ready();

    const assertion = makeAssertion({ jti: "replay-test-jti" });

    // First use — should succeed
    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/sso/verify",
      headers: { "x-api-key": "test-key" },
      payload: { assertion },
    });
    expect(res1.statusCode).toBe(200);

    // Replay — should fail with 409
    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/sso/verify",
      headers: { "x-api-key": "test-key" },
      payload: { assertion },
    });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error).toContain("already used");
  });

  it("JTI-DB-03: expired assertion returns 401", async () => {
    const app = Fastify();
    await app.register(ssoRoutes);
    await app.ready();

    const assertion = jwt.sign(
      {
        sub: "1",
        email: "test@example.com",
        iss: "ammawallet",
        aud: "lms-amma-sso",
        jti: "expired-jti",
      },
      mockConfig.SSO_SECRET,
      { expiresIn: -1 }, // already expired
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/verify",
      headers: { "x-api-key": "test-key" },
      payload: { assertion },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("Invalid or expired");
  });

  it("JTI-DB-04: different JTIs are independent (no cross-contamination)", async () => {
    const app = Fastify();
    await app.register(ssoRoutes);
    await app.ready();

    const assertion1 = makeAssertion({ jti: "jti-a" });
    const assertion2 = makeAssertion({ jti: "jti-b" });

    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/sso/verify",
      headers: { "x-api-key": "test-key" },
      payload: { assertion: assertion1 },
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/sso/verify",
      headers: { "x-api-key": "test-key" },
      payload: { assertion: assertion2 },
    });
    expect(res2.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WA-05. Default (SSO_AUDIENCE_ENFORCE off) must behave exactly like the pre-WA-05 image,
// so the LMS keeps signing in when the image is deployed before the cutover.
// ─────────────────────────────────────────────────────────────────────────────
const wa05 = () => {
  const build = async () => { const app = Fastify(); await app.register(ssoRoutes); await app.ready(); return app; };
  type App = Awaited<ReturnType<typeof build>>;
  const issueFor = (app: App, origin: string, state = "state-a") =>
    app.inject({ method: "POST", url: "/api/v1/sso/token", payload: { callbackUrl: `${origin}/callback`, state } });
  const verifyAs = (app: App, key: any, assertion: string, state?: string) => {
    keyCtx.value = key;
    return app.inject({ method: "POST", url: "/api/v1/sso/verify", payload: state === undefined ? { assertion } : { assertion, state } });
  };
  const legacyAssertion = () => jwt.sign(
    { sub: "1", email: "test@example.com", isEmailVerified: true, iss: "ammawallet", aud: "lms-amma-sso", jti: "legacy-" + Math.random().toString(36).slice(2) },
    mockConfig.SSO_SECRET, { expiresIn: 60 });
  const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();
  const yesterday = () => new Date(Date.now() - 86_400_000).toISOString();
  return { build, issueFor, verifyAs, legacyAssertion, tomorrow, yesterday };
};

describe("WA-05 transition: the LMS's current call pattern keeps working (enforce off, the default)", () => {
  const h = wa05();
  beforeEach(() => {
    vi.clearAllMocks(); consumedJtis.clear(); setupJtiMock();
    mockConfig.SSO_AUDIENCE_ENFORCE = false;
    mockConfig.SSO_LEGACY_AUD_UNTIL = ""; mockConfig.SSO_LEGACY_AUD_TENANT_ID = 0; mockConfig.SSO_ENV_KEY_UNTIL = "";
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.example.invalid"]; // old format, origins only
    keyCtx.value = undefined;
  });

  it("issues the old assertion shape for an origins-only whitelist", async () => {
    const app = await h.build();
    try {
      const res = await h.issueFor(app, "https://lms.example.invalid");
      expect(res.statusCode).toBe(200);
      const claims = jwt.decode(res.json().assertionToken) as jwt.JwtPayload;
      expect(claims.aud).toBe("lms-amma-sso");
      expect(claims.iss).toBe("ammawallet");
      expect(claims.cbo).toBeUndefined();
      expect(claims.sth).toBeUndefined();
    } finally { await app.close(); }
  });

  it("verifies with an env key and no state, as the LMS does today", async () => {
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://lms.example.invalid")).json().assertionToken;
      const res = await h.verifyAs(app, envKey, token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ userId: "1" });
    } finally { await app.close(); }
  });

  it("verifies with a DB tenant key and no state", async () => {
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://lms.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, dbKey(12), token)).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("verifies an old-format token from an old image", async () => {
    const app = await h.build();
    try {
      expect((await h.verifyAs(app, envKey, h.legacyAssertion())).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("still accepts origin=tenant whitelist entries and still issues the old audience", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.example.invalid=12"];
    const app = await h.build();
    try {
      const res = await h.issueFor(app, "https://lms.example.invalid");
      expect(res.statusCode).toBe(200);
      expect((jwt.decode(res.json().assertionToken) as jwt.JwtPayload).aud).toBe("lms-amma-sso");
      expect((await h.verifyAs(app, dbKey(12), res.json().assertionToken)).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("ignores a state sent to verify, as today", async () => {
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://lms.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, dbKey(12), token, "anything")).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

describe("WA-05 enforced: SSO assertions are bound to one relying party", () => {
  const h = wa05();
  beforeEach(() => {
    vi.clearAllMocks(); consumedJtis.clear(); setupJtiMock();
    mockConfig.SSO_AUDIENCE_ENFORCE = true;
    mockConfig.SSO_LEGACY_AUD_UNTIL = ""; mockConfig.SSO_LEGACY_AUD_TENANT_ID = 0; mockConfig.SSO_ENV_KEY_UNTIL = "";
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://rp-a.example.invalid=7", "https://rp-b.example.invalid=8"];
    keyCtx.value = dbKey(7);
  });
  afterEach(() => { mockConfig.SSO_AUDIENCE_ENFORCE = false; });

  it("binds the assertion to the tenant of the whitelist entry that issued it", async () => {
    const app = await h.build();
    try {
      const res = await h.issueFor(app, "https://rp-a.example.invalid");
      expect(res.statusCode).toBe(200);
      const token = res.json().assertionToken as string;
      expect((jwt.decode(token) as jwt.JwtPayload).aud).toBe("tenant:7");
      expect((await h.verifyAs(app, dbKey(7), token, "state-a")).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("refuses to issue for a whitelisted origin that has no tenant id", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://rp-a.example.invalid=7", "https://rp-c.example.invalid"];
    const app = await h.build();
    try {
      const res = await h.issueFor(app, "https://rp-c.example.invalid");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("whitelist");
    } finally { await app.close(); }
  });

  it("puts the callback origin and the sha256 of state in the assertion", async () => {
    const app = await h.build();
    try {
      const claims = jwt.decode((await h.issueFor(app, "https://rp-a.example.invalid", "state-a")).json().assertionToken) as jwt.JwtPayload;
      expect(claims.cbo).toBe("https://rp-a.example.invalid");
      expect(claims.sth).toBe(createHash("sha256").update("state-a").digest("hex"));
      expect(JSON.stringify(claims)).not.toContain("state-a");
    } finally { await app.close(); }
  });

  it("refuses an assertion issued for another tenant without consuming it", async () => {
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://rp-a.example.invalid")).json().assertionToken;
      const wrong = await h.verifyAs(app, dbKey(8), token, "state-a");
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual({ error: "Invalid or expired assertion" });
      expect((await h.verifyAs(app, dbKey(7), token, "state-a")).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("refuses env API keys on verify", async () => {
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://rp-a.example.invalid")).json().assertionToken;
      const res = await h.verifyAs(app, envKey, token, "state-a");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "SSO verify needs a tenant API key" });
      expect((await h.verifyAs(app, dbKey(7), token, "state-a")).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("refuses a verify whose state does not match", async () => {
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://rp-a.example.invalid", "state-a")).json().assertionToken;
      const res = await h.verifyAs(app, dbKey(7), token, "state-b");
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "Invalid or expired assertion" });
      expect((await h.verifyAs(app, dbKey(7), token, "state-a")).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("requires state once the legacy window is closed", async () => {
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://rp-a.example.invalid")).json().assertionToken;
      const res = await h.verifyAs(app, dbKey(7), token);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "state is required" });
    } finally { await app.close(); }
  });

  it("requires state from a non-LMS tenant even while the legacy window is open", async () => {
    mockConfig.SSO_LEGACY_AUD_UNTIL = h.tomorrow();
    mockConfig.SSO_LEGACY_AUD_TENANT_ID = 7;
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://rp-b.example.invalid")).json().assertionToken;
      const res = await h.verifyAs(app, dbKey(8), token);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "state is required" });
    } finally { await app.close(); }
  });

  it("lets the LMS tenant verify without state while the legacy window is open", async () => {
    mockConfig.SSO_LEGACY_AUD_UNTIL = h.tomorrow();
    mockConfig.SSO_LEGACY_AUD_TENANT_ID = 7;
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://rp-a.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, dbKey(7), token)).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("refuses every callback when no whitelist entry has a tenant id", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://rp-a.example.invalid"];
    const app = await h.build();
    try {
      const res = await h.issueFor(app, "https://rp-a.example.invalid");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "SSO callback whitelist not configured" });
    } finally { await app.close(); }
  });

  it("accepts an env key as the LMS tenant only while SSO_ENV_KEY_UNTIL is open", async () => {
    mockConfig.SSO_LEGACY_AUD_TENANT_ID = 7;
    mockConfig.SSO_ENV_KEY_UNTIL = h.tomorrow();
    const app = await h.build();
    try {
      const forB = (await h.issueFor(app, "https://rp-b.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, envKey, forB, "state-a")).statusCode).toBe(401);
      const forA = (await h.issueFor(app, "https://rp-a.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, envKey, forA, "state-a")).statusCode).toBe(200);
      mockConfig.SSO_ENV_KEY_UNTIL = h.yesterday();
      const later = (await h.issueFor(app, "https://rp-a.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, envKey, later, "state-a")).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it("refuses an env key in the window when SSO_LEGACY_AUD_TENANT_ID is not set", async () => {
    mockConfig.SSO_ENV_KEY_UNTIL = h.tomorrow();
    const app = await h.build();
    try {
      const token = (await h.issueFor(app, "https://rp-a.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, envKey, token, "state-a")).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it("accepts the legacy audience only for the LMS tenant before SSO_LEGACY_AUD_UNTIL", async () => {
    mockConfig.SSO_LEGACY_AUD_UNTIL = h.tomorrow();
    mockConfig.SSO_LEGACY_AUD_TENANT_ID = 7;
    const app = await h.build();
    try {
      const token = h.legacyAssertion();
      expect((await h.verifyAs(app, dbKey(8), token)).statusCode).toBe(401);
      expect((await h.verifyAs(app, dbKey(7), token)).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("refuses the legacy audience after SSO_LEGACY_AUD_UNTIL", async () => {
    mockConfig.SSO_LEGACY_AUD_UNTIL = h.yesterday();
    mockConfig.SSO_LEGACY_AUD_TENANT_ID = 7;
    const app = await h.build();
    try {
      expect((await h.verifyAs(app, dbKey(7), h.legacyAssertion())).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("adds the legacy audience to new LMS assertions only while the window is open", async () => {
    mockConfig.SSO_LEGACY_AUD_UNTIL = h.tomorrow();
    mockConfig.SSO_LEGACY_AUD_TENANT_ID = 7;
    const app = await h.build();
    try {
      const aud = async (origin: string) => (jwt.decode((await h.issueFor(app, origin)).json().assertionToken) as jwt.JwtPayload).aud;
      expect(await aud("https://rp-a.example.invalid")).toEqual(["tenant:7", "lms-amma-sso"]);
      expect(await aud("https://rp-b.example.invalid")).toBe("tenant:8");
      mockConfig.SSO_LEGACY_AUD_UNTIL = "";
      expect(await aud("https://rp-a.example.invalid")).toBe("tenant:7");
    } finally { await app.close(); }
  });
});

describe("WA-05 off-mode byte-identical details", () => {
  const h = wa05();
  beforeEach(() => {
    vi.clearAllMocks(); consumedJtis.clear(); setupJtiMock();
    mockConfig.SSO_AUDIENCE_ENFORCE = false;
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.example.invalid"];
    keyCtx.value = dbKey(12);
  });

  it("does not validate state on verify when off (long or non-string state is ignored)", async () => {
    const app = await h.build();
    try {
      const t1 = (await h.issueFor(app, "https://lms.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, dbKey(12), t1, "x".repeat(5000))).statusCode).toBe(200);
      const t2 = (await h.issueFor(app, "https://lms.example.invalid")).json().assertionToken;
      keyCtx.value = dbKey(12);
      const res = await app.inject({ method: "POST", url: "/api/v1/sso/verify", payload: { assertion: t2, state: { a: 1 } } });
      expect(res.statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("rejects an oversize or non-string state on verify when enforcing", async () => {
    mockConfig.SSO_AUDIENCE_ENFORCE = true;
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.example.invalid=12"];
    const app = await h.build();
    try {
      const t = (await h.issueFor(app, "https://lms.example.invalid")).json().assertionToken;
      expect((await h.verifyAs(app, dbKey(12), t, "x".repeat(5000))).statusCode).toBe(400);
    } finally { mockConfig.SSO_AUDIENCE_ENFORCE = false; await app.close(); }
  });

  it("keeps the old 403 text when the whitelist has entries but none parse", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["not a url"];
    const app = await h.build();
    try {
      const res = await h.issueFor(app, "https://lms.example.invalid");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "Callback URL not in SSO whitelist" });
    } finally { await app.close(); }
  });

  it("matches a bare whitelist entry containing = by origin", async () => {
    mockConfig.SSO_CALLBACK_WHITELIST = ["https://lms.example.invalid/x?a=1"];
    const app = await h.build();
    try {
      expect((await h.issueFor(app, "https://lms.example.invalid")).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it("warns about an env key only when the key is an env key", async () => {
    const app = await h.build();
    const warn = vi.spyOn(app.log, "warn");
    try {
      const t = (await h.issueFor(app, "https://lms.example.invalid")).json().assertionToken;
      await h.verifyAs(app, undefined, t);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("Env API key"))).toBe(false);
    } finally { await app.close(); }
  });
});
