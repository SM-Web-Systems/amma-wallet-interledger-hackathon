import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({
  TURNSTILE_SECRET_KEY: "test-turnstile-secret",
}));

vi.mock("../config", () => ({
  config: mockConfig,
}));

// The 2FA step may skip Turnstile only for an account that really has 2FA on.
const twoFaUsers = vi.hoisted(() => new Map<string, boolean>());
vi.mock("../db", () => ({
  schema: { users: { email: "email", phoneNumber: "phone_number", twoFaEnabled: "two_fa_enabled" } },
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { value: string }) => ({
          limit: async () => (twoFaUsers.has(cond.value) ? [{ twoFaEnabled: twoFaUsers.get(cond.value) }] : []),
        }),
      }),
    }),
  },
}));
vi.mock("drizzle-orm", () => ({ eq: (_col: unknown, value: string) => ({ value }) }));

vi.mock("./tenant-api-key", () => ({
  resolveTenantApiKey: vi.fn().mockResolvedValue(null),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { verifyTurnstile } from "./turnstile";

function makeRequest(body: any = {}, url = "/api/v1/auth/register") {
  return {
    body,
    ip: "127.0.0.1",
    headers: {},
    routeOptions: { url },
  } as any;
}

function makeReply() {
  const reply: any = {
    sent: false,
    statusCode: 200,
    body: null,
  };
  reply.status = vi.fn((code: number) => {
    reply.statusCode = code;
    return reply;
  });
  reply.send = vi.fn((data: any) => {
    reply.body = data;
    reply.sent = true;
    return reply;
  });
  return reply;
}

describe("Turnstile middleware (P0-1-F4 + P0-1-F11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    twoFaUsers.clear();
    mockConfig.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
  });

  it("returns 400 when no turnstile token provided", async () => {
    const req = makeRequest({});
    const rep = makeReply();
    await verifyTurnstile(req, rep);
    expect(rep.status).toHaveBeenCalledWith(400);
  });

  it("returns 403 when Cloudflare says verification failed", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ success: false, "error-codes": ["invalid-input-response"] }),
    });

    const req = makeRequest({ turnstileToken: "bad-token" });
    const rep = makeReply();
    await verifyTurnstile(req, rep);
    expect(rep.status).toHaveBeenCalledWith(403);
  });

  it("allows request when Cloudflare says verification succeeded", async () => {
    mockFetch.mockResolvedValueOnce({
      json: () => Promise.resolve({ success: true }),
    });

    const req = makeRequest({ turnstileToken: "good-token" });
    const rep = makeReply();
    await verifyTurnstile(req, rep);
    // Should not call reply.status at all — request passes through
    expect(rep.status).not.toHaveBeenCalled();
  });

  it("returns 503 when Cloudflare is unreachable (fail-closed, P0-1-F4)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const req = makeRequest({ turnstileToken: "some-token" });
    const rep = makeReply();
    await verifyTurnstile(req, rep);
    expect(rep.status).toHaveBeenCalledWith(503);
    expect(rep.body.error).toContain("unavailable");
  });

  it("skips Turnstile in dev when no key configured", async () => {
    mockConfig.TURNSTILE_SECRET_KEY = "";
    const req = makeRequest({});
    const rep = makeReply();
    await verifyTurnstile(req, rep);
    expect(rep.status).not.toHaveBeenCalled();
  });

  it("twoFaToken on login route skips Turnstile for an account with 2FA on (P0-1-F11 — allowed)", async () => {
    twoFaUsers.set("twofa@example.com", true);
    const req = makeRequest({ email: "TwoFa@Example.com ", password: "x", twoFaToken: "123456" }, "/api/v1/auth/login");
    const rep = makeReply();
    await verifyTurnstile(req, rep);
    expect(rep.status).not.toHaveBeenCalled();
  });

  it("twoFaToken does NOT skip Turnstile for an account without 2FA (captcha bypass)", async () => {
    twoFaUsers.set("plain@example.com", false);
    const req = makeRequest({ email: "plain@example.com", password: "x", twoFaToken: "anything" }, "/api/v1/auth/login");
    const rep = makeReply();
    await verifyTurnstile(req, rep);
    expect(rep.status).toHaveBeenCalledWith(400);
  });

  it("twoFaToken does NOT skip Turnstile for an unknown account or a missing identifier", async () => {
    for (const body of [{ email: "nobody@example.com", twoFaToken: "1" }, { phoneNumber: "+15550001111", twoFaToken: "1" }, { twoFaToken: "1" }]) {
      const rep = makeReply();
      await verifyTurnstile(makeRequest(body, "/api/v1/auth/login"), rep);
      expect(rep.status).toHaveBeenCalledWith(400);
    }
  });

  it("looks up phone-number logins too", async () => {
    twoFaUsers.set("+15550002222", true);
    const rep = makeReply();
    await verifyTurnstile(makeRequest({ phoneNumber: "+15550002222", twoFaToken: "123456" }, "/api/v1/auth/login"), rep);
    expect(rep.status).not.toHaveBeenCalled();
  });

  it("twoFaToken on register route does NOT skip Turnstile (P0-1-F11 — rejected)", async () => {
    const req = makeRequest({ twoFaToken: "some-token" }, "/api/v1/auth/register");
    const rep = makeReply();
    await verifyTurnstile(req, rep);
    // Should still require turnstileToken — returns 400
    expect(rep.status).toHaveBeenCalledWith(400);
  });
});
