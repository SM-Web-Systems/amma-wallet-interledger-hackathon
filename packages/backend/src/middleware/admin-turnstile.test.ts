import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Admin console sign-in: its own Cloudflare Turnstile check, off unless ADMIN_TURNSTILE=on, and fail-closed when on.
const cfg = vi.hoisted(() => ({
  ADMIN_TURNSTILE: "off",
  ADMIN_TURNSTILE_SITE_KEY: "",
  ADMIN_TURNSTILE_SECRET_KEY: "",
  ADMIN_TURNSTILE_HOSTNAMES: ["ammawallet.com"],
}));
vi.mock("../config", () => ({ config: cfg }));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { setAppLogger } from "../lib/app-log";
import { verifyAdminTurnstile, adminTurnstilePublicConfig, ADMIN_TURNSTILE_ACTION } from "./admin-turnstile";

const SECRET = "0x4AAAAAAA-admin-secret-never-logged";
const TOKEN = "cf-token-abc";
const req = (body: any = { email: "a@b.c", password: "x", turnstileToken: TOKEN }) => ({ body, ip: "203.0.113.9", headers: {} }) as any;
function reply() {
  const r: any = { statusCode: 200, body: undefined, sent: false };
  r.status = vi.fn((c: number) => ((r.statusCode = c), r));
  r.send = vi.fn((b: any) => ((r.body = b), (r.sent = true), r));
  return r;
}
const cf = (data: any, ok = true) => mockFetch.mockResolvedValueOnce({ ok, status: ok ? 200 : 500, json: async () => data });
const good = { success: true, hostname: "ammawallet.com", action: ADMIN_TURNSTILE_ACTION };

let logs: string[] = [];
beforeEach(() => {
  mockFetch.mockReset();
  Object.assign(cfg, { ADMIN_TURNSTILE: "on", ADMIN_TURNSTILE_SITE_KEY: "0xSITE", ADMIN_TURNSTILE_SECRET_KEY: SECRET, ADMIN_TURNSTILE_HOSTNAMES: ["ammawallet.com"] });
  logs = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: any[]) => { logs.push(a.map(String).join(" ")); });
  const keep = (o: unknown, msg?: string) => { logs.push(JSON.stringify(o) + " " + String(msg)); };
  setAppLogger({ info: keep, warn: keep, error: keep });
});
afterEach(() => { vi.restoreAllMocks(); setAppLogger(null); });

describe("admin sign-in Turnstile: switched off", () => {
  it("does nothing when ADMIN_TURNSTILE is off (the default), even with no token", async () => {
    cfg.ADMIN_TURNSTILE = "off";
    const r = reply();
    await verifyAdminTurnstile(req({ email: "a@b.c", password: "x" }), r);
    expect(r.sent).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(adminTurnstilePublicConfig()).toEqual({ enabled: false, siteKey: null });
  });

  it("treats anything other than on as off (break-glass: set off and restart the API)", async () => {
    for (const v of ["", "OFF", "false"]) {
      cfg.ADMIN_TURNSTILE = v;
      const r = reply();
      await verifyAdminTurnstile(req({}), r);
      expect(r.sent).toBe(false);
    }
  });
});

describe("admin sign-in Turnstile: switched on", () => {
  it("tells the admin page the site key, and never the secret", () => {
    const pub = adminTurnstilePublicConfig();
    expect(pub).toEqual({ enabled: true, siteKey: "0xSITE" });
    expect(JSON.stringify(pub)).not.toContain(SECRET);
  });

  it("accepts ON in any case", async () => {
    cfg.ADMIN_TURNSTILE = " ON ";
    cf(good);
    const r = reply();
    await verifyAdminTurnstile(req(), r);
    expect(r.sent).toBe(false);
  });

  it("refuses when the site key or secret is missing (fail closed, no call to Cloudflare)", async () => {
    for (const k of ["ADMIN_TURNSTILE_SECRET_KEY", "ADMIN_TURNSTILE_SITE_KEY"] as const) {
      Object.assign(cfg, { ADMIN_TURNSTILE_SITE_KEY: "0xSITE", ADMIN_TURNSTILE_SECRET_KEY: SECRET, [k]: "" });
      const r = reply();
      await verifyAdminTurnstile(req(), r);
      expect(r.statusCode).toBe(503);
      expect(adminTurnstilePublicConfig().enabled).toBe(true);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses with 400 when no token is sent", async () => {
    const r = reply();
    await verifyAdminTurnstile(req({ email: "a@b.c", password: "x" }), r);
    expect(r.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends secret, token and IP to Siteverify and lets a valid token through", async () => {
    cf(good);
    const r = reply();
    await verifyAdminTurnstile(req(), r);
    expect(r.sent).toBe(false);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const sent = new URLSearchParams(String(init.body));
    expect(sent.get("secret")).toBe(SECRET);
    expect(sent.get("response")).toBe(TOKEN);
    expect(sent.get("remoteip")).toBe("203.0.113.9");
    expect(init.signal).toBeDefined(); // bounded wait
  });

  it.each([
    ["Cloudflare says no", { success: false, "error-codes": ["invalid-input-response"] }],
    ["wrong hostname", { ...good, hostname: "evil.example" }],
    ["missing hostname", { success: true, action: ADMIN_TURNSTILE_ACTION }],
    ["wrong action (a user-login token)", { ...good, action: "login" }],
    ["missing action", { success: true, hostname: "ammawallet.com" }],
  ])("refuses with 403: %s", async (_name, data) => {
    cf(data);
    const r = reply();
    await verifyAdminTurnstile(req(), r);
    expect(r.statusCode).toBe(403);
  });

  it("allows any configured hostname, compared without case", async () => {
    cfg.ADMIN_TURNSTILE_HOSTNAMES = ["ammawallet.com", "testnet.ammawallet.com"];
    cf({ ...good, hostname: "TestNet.AmmaWallet.com" });
    const r = reply();
    await verifyAdminTurnstile(req(), r);
    expect(r.sent).toBe(false);
  });

  it.each([
    ["network error", () => mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"))],
    ["HTTP 500", () => cf({}, false)],
    ["not JSON", () => mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } })],
    ["JSON null", () => cf(null)],
    ["timeout", () => mockFetch.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }))],
  ])("refuses with 503 when Cloudflare cannot answer: %s", async (_name, arrange) => {
    arrange();
    const r = reply();
    await verifyAdminTurnstile(req(), r);
    expect(r.statusCode).toBe(503);
  });

  it("never logs the secret or the token", async () => {
    cf({ success: false, "error-codes": ["invalid-input-secret"] });
    await verifyAdminTurnstile(req(), reply());
    mockFetch.mockRejectedValueOnce(new Error(`boom ${SECRET} ${TOKEN}`));
    await verifyAdminTurnstile(req(), reply());
    const all = logs.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(TOKEN);
  });
});
