import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";

// The admin sign-in route runs the admin Turnstile check before it looks up the admin or compares the password,
// and the admin page can read whether the check is on (and its public site key) from /api/v1/internal/auth/config.
const cfg = vi.hoisted(() => ({
  ADMIN_TURNSTILE: "off",
  ADMIN_TURNSTILE_SITE_KEY: "0xSITE",
  ADMIN_TURNSTILE_SECRET_KEY: "admin-secret-xyz",
  ADMIN_TURNSTILE_HOSTNAMES: ["ammawallet.com"],
  ADMIN_JWT_SECRET: "admin-jwt-secret-for-tests",
  ADMIN_JWT_EXPIRES_IN: 3600,
}));
vi.mock("../config", () => ({ config: cfg }));

const dbm = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock("../db", () => ({
  db: dbm,
  schema: { internalAdmins: { id: "id", email: "email", name: "name", role: "role", passwordHash: "password_hash", isActive: "is_active", lastLoginAt: "last_login_at" } },
}));
const compare = vi.hoisted(() => vi.fn());
vi.mock("bcryptjs", () => ({ default: { compare, hash: vi.fn() } }));
vi.mock("../lib/audit", () => ({ auditLog: vi.fn() }));
vi.mock("../services/billing.service", () => ({}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { adminRoutes } from "./admin";

const app = Fastify();
await app.register(adminRoutes);
afterAll(() => app.close());

const ADMIN = { id: 7, email: "ops@ammawallet.com", name: "Ops", role: "super_admin", passwordHash: "$2b$12$h", isActive: true };
const login = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/internal/auth/login", payload: body });

beforeEach(() => {
  cfg.ADMIN_TURNSTILE = "off";
  mockFetch.mockReset();
  compare.mockReset().mockResolvedValue(true);
  dbm.select.mockReset().mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [ADMIN] }) }) });
  dbm.update.mockReset().mockReturnValue({ set: () => ({ where: () => ({ catch: () => undefined }) }) });
});

describe("admin sign-in with the Turnstile switch", () => {
  it("off: signs in as before, with no Cloudflare call", async () => {
    const res = await login({ email: ADMIN.email, password: "pw" });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
    const c = await app.inject({ method: "GET", url: "/api/v1/internal/auth/config" });
    expect(c.json()).toEqual({ turnstile: { enabled: false, siteKey: null } });
  });

  it("on: refuses without a token before looking up the admin or the password", async () => {
    cfg.ADMIN_TURNSTILE = "on";
    const res = await login({ email: ADMIN.email, password: "pw" });
    expect(res.statusCode).toBe(400);
    expect(dbm.select).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("on: a non-string token is never a pass", async () => {
    cfg.ADMIN_TURNSTILE = "on";
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: false }) });
    for (const t of [123, null, { a: 1 }, ["x"]]) {
      const res = await login({ email: ADMIN.email, password: "pw", turnstileToken: t });
      expect([400, 403]).toContain(res.statusCode);
    }
    expect(compare).not.toHaveBeenCalled();
    mockFetch.mockReset();
  });

  it("on: refuses a token Cloudflare rejects, with no password check", async () => {
    cfg.ADMIN_TURNSTILE = "on";
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: false }) });
    const res = await login({ email: ADMIN.email, password: "pw", turnstileToken: "t" });
    expect(res.statusCode).toBe(403);
    expect(compare).not.toHaveBeenCalled();
  });

  it("on: a valid token reaches the normal password check", async () => {
    cfg.ADMIN_TURNSTILE = "on";
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, hostname: "ammawallet.com", action: "admin-login" }) });
    const ok = await login({ email: ADMIN.email, password: "pw", turnstileToken: "t" });
    expect(ok.statusCode).toBe(200);
    compare.mockResolvedValueOnce(false);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, hostname: "ammawallet.com", action: "admin-login" }) });
    const bad = await login({ email: ADMIN.email, password: "wrong", turnstileToken: "t2" });
    expect(bad.statusCode).toBe(401);
  });

  it("on: the config endpoint gives the site key and never the secret", async () => {
    cfg.ADMIN_TURNSTILE = "on";
    const c = await app.inject({ method: "GET", url: "/api/v1/internal/auth/config" });
    expect(c.statusCode).toBe(200);
    expect(c.json()).toEqual({ turnstile: { enabled: true, siteKey: "0xSITE" } });
    expect(c.body).not.toContain("admin-secret-xyz");
  });
});
