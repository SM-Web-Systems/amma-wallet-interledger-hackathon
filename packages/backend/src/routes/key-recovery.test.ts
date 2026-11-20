import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyKeyRecovery } from "../db/migrations/key-recovery";
import { LocalMasterKeyProvider, sealForEscrow } from "../lib/key-wrapper";

// Managed wallet (custody plan, step 5a): a user who forgot their wallet passphrase asks for recovery.
// Identity: signed in + account password + a code sent to their email. Then a wait (so the real owner can
// cancel), alerts by email, and only then the phrase is handed back, once.
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1 }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet", WEB_APP_URL: "https://wallet.test", TOTP_ENCRYPTION_KEY: "a".repeat(64) } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));

import { keyRecoveryRoutes } from "./key-recovery";
import { hashEmailCode } from "../lib/code-hash";
import { recoveryFreezeActive } from "../lib/key-recovery";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PASSWORD = "correct horse battery staple";
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 5).toString("base64"));
const mail = { code: vi.fn(async (_to: string, _code: string) => {}), alert: vi.fn(async (_to: string, _readyAt: Date, _cancelUrl: string) => {}), cancelled: vi.fn(async (_to: string) => {}) };
let pg: PGlite;
let app: FastifyInstance;
let off: FastifyInstance;

const auditRows = async () => (await pg.query("SELECT user_id, action, detail FROM audit_logs ORDER BY id")).rows as { user_id: number; action: string; detail: any }[];
const post = (url: string, payload: unknown, a = app) => a.inject({ method: "POST", url, payload: payload as any });
const get = (url: string, a = app) => a.inject({ method: "GET", url });
const lastCode = () => String(mail.code.mock.calls.at(-1)![1]);
async function sendCode() { await post("/api/v1/key-recovery/code", {}); return lastCode(); }
async function request(over: Record<string, unknown> = {}) {
  const code = (over.code as string | undefined) ?? (await sendCode());
  return post("/api/v1/key-recovery/request", { password: PASSWORD, code, ...over });
}
const makeReady = () => pg.query("UPDATE wallet_key_recovery SET ready_at = now() - interval '1 minute' WHERE state='pending'");
const tokenFromAlert = () => new URL(String(mail.alert.mock.calls.at(-1)![2])).searchParams.get("token")!;

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  await applyKeyEscrow(conn); await applyKeyRecovery(conn);
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now());
    CREATE TABLE IF NOT EXISTS email_codes (
    id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE, code text NOT NULL,
    type text NOT NULL DEFAULT 'login', expires_at timestamptz NOT NULL, used boolean DEFAULT false, created_at timestamptz DEFAULT now())`);
  await pg.query("UPDATE users SET password_hash=$1 WHERE id IN (1,2)", [await bcrypt.hash(PASSWORD, 4)]);
  state.db = drizzle(pg);
  app = Fastify(); await app.register(keyRecoveryRoutes, { provider, mail, waitHours: 48 }); await app.ready();
  off = Fastify(); await off.register(keyRecoveryRoutes, { provider: null, mail, waitHours: 48 }); await off.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1;
  mail.code.mockClear(); mail.alert.mockClear(); mail.cancelled.mockClear();
  await pg.exec("TRUNCATE wallet_key_recovery, wallet_key_escrow, email_codes; TRUNCATE audit_logs RESTART IDENTITY; UPDATE users SET signing_mode='delegated'");
  const sealed = await sealForEscrow(provider, PHRASE, { userId: 1, kind: "phrase" });
  await pg.query("INSERT INTO wallet_key_escrow(user_id,kind,sealed,provider) VALUES (1,'phrase',$1,'local')", [sealed]);
});
afterAll(async () => { await app?.close(); await off?.close(); await pg?.close(); });

describe("asking for recovery", () => {
  it("emails a 6 digit code to the account's address and stores only a hash of it", async () => {
    const res = await post("/api/v1/key-recovery/code", {});
    expect(res.statusCode).toBe(200);
    expect(mail.code).toHaveBeenCalledTimes(1);
    expect(mail.code.mock.calls[0][0]).toBe("one@example.invalid");
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    const rows = (await pg.query("SELECT code, type FROM email_codes")).rows as { code: string; type: string }[];
    expect(rows).toEqual([{ code: hashEmailCode(code), type: "key-recovery" }]);
    // a keyed hash, not a plain SHA-256 of six digits that could be brute forced from a database copy
    expect(rows[0].code).not.toBe(createHash("sha256").update(code).digest("hex"));
    expect(res.body).not.toContain(code);
  });

  it("starts a waiting request when password and code are right, and alerts the owner with a way to cancel", async () => {
    const before = Date.now();
    const res = await request();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("waiting");
    const readyAt = new Date(body.readyAt).getTime();
    expect(readyAt).toBeGreaterThanOrEqual(before + 48 * 3600_000 - 5000);
    expect(readyAt).toBeLessThanOrEqual(Date.now() + 48 * 3600_000 + 5000);
    expect(mail.alert).toHaveBeenCalledTimes(1);
    expect(mail.alert.mock.calls[0][0]).toBe("one@example.invalid");
    expect(String(mail.alert.mock.calls[0][2])).toMatch(/^https:\/\/wallet\.test\/.+token=[0-9a-f]{64}$/);
  });

  it("stores only a hash of the cancel token", async () => {
    await request();
    const token = tokenFromAlert();
    const [row] = (await pg.query("SELECT cancel_token_hash FROM wallet_key_recovery")).rows as { cancel_token_hash: string }[];
    expect(row.cancel_token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("refuses a wrong password and a wrong or used or expired code, and records the refusals", async () => {
    const code = await sendCode();
    expect((await post("/api/v1/key-recovery/request", { password: "wrong password here", code })).statusCode).toBe(403);
    expect((await post("/api/v1/key-recovery/request", { password: PASSWORD, code: "000000" })).statusCode).toBe(403);
    expect((await post("/api/v1/key-recovery/request", { password: PASSWORD, code })).statusCode).toBe(200);
    await pg.exec("TRUNCATE wallet_key_recovery");
    expect((await post("/api/v1/key-recovery/request", { password: PASSWORD, code })).statusCode).toBe(403); // used
    const fresh = await sendCode();
    await pg.exec("UPDATE email_codes SET expires_at = now() - interval '1 minute' WHERE used = false");
    expect((await post("/api/v1/key-recovery/request", { password: PASSWORD, code: fresh })).statusCode).toBe(403);
    expect((await auditRows()).filter((r) => r.action === "key_recovery_denied").length).toBeGreaterThanOrEqual(3);
    expect(mail.alert).toHaveBeenCalledTimes(1);
  });

  it("does not start a second request while one is waiting", async () => {
    await request();
    expect((await request()).statusCode).toBe(409);
    expect((await pg.query("SELECT count(*)::int AS n FROM wallet_key_recovery")).rows[0]).toEqual({ n: 1 });
  });

  it("starts nothing when Amma holds no phrase backup for the user", async () => {
    await pg.exec("TRUNCATE wallet_key_escrow");
    expect((await request()).statusCode).toBe(404);
    expect((await pg.query("SELECT count(*)::int AS n FROM wallet_key_recovery")).rows[0]).toEqual({ n: 0 });
    expect(mail.alert).not.toHaveBeenCalled();
  });

  it("leaves self-custody users alone", async () => {
    await pg.query("UPDATE users SET signing_mode='self' WHERE id=1");
    expect((await request()).statusCode).toBe(409);
  });

  it("is off, and says so, until a master key provider is configured", async () => {
    expect((await post("/api/v1/key-recovery/code", {}, off)).statusCode).toBe(503);
    expect((await post("/api/v1/key-recovery/request", { password: PASSWORD, code: "123456" }, off)).statusCode).toBe(503);
    expect((await get("/api/v1/key-recovery/status", off)).json()).toEqual({ enabled: false, state: "none" });
  });
});

describe("waiting, status and cancelling", () => {
  it("reports none, waiting and ready", async () => {
    expect((await get("/api/v1/key-recovery/status")).json()).toEqual({ enabled: true, state: "none" });
    await request();
    const waiting = (await get("/api/v1/key-recovery/status")).json();
    expect(waiting.state).toBe("waiting");
    expect(new Date(waiting.readyAt).getTime()).toBeGreaterThan(Date.now());
    await makeReady();
    expect((await get("/api/v1/key-recovery/status")).json().state).toBe("ready");
  });

  it("lets the signed-in owner cancel, tells them by email, and unfreezes", async () => {
    await request();
    expect(await recoveryFreezeActive(1)).toBe(true);
    expect((await post("/api/v1/key-recovery/cancel", {})).statusCode).toBe(200);
    expect(mail.cancelled).toHaveBeenCalledWith("one@example.invalid");
    expect((await get("/api/v1/key-recovery/status")).json().state).toBe("none");
    expect(await recoveryFreezeActive(1)).toBe(false);
  });

  it("lets the cancel link in the alert email cancel without signing in, once", async () => {
    await request();
    const token = tokenFromAlert();
    expect((await post("/api/v1/key-recovery/cancel-by-token", { token })).statusCode).toBe(200);
    expect((await post("/api/v1/key-recovery/cancel-by-token", { token })).statusCode).toBe(404);
    expect((await post("/api/v1/key-recovery/cancel-by-token", { token: "f".repeat(64) })).statusCode).toBe(404);
    expect((await post("/api/v1/key-recovery/cancel-by-token", { token: "short" })).statusCode).toBe(400);
    expect((await auditRows()).map((r) => r.action)).toContain("key_recovery_cancelled");
  });

  it("only lets a user see and cancel their own request", async () => {
    await request();
    state.userId = 2;
    expect((await get("/api/v1/key-recovery/status")).json().state).toBe("none");
    expect((await post("/api/v1/key-recovery/cancel", {})).statusCode).toBe(404);
    state.userId = 1;
    expect((await get("/api/v1/key-recovery/status")).json().state).toBe("waiting");
  });
});

describe("finishing the recovery", () => {
  it("hands back the phrase once the wait is over, after the password is typed again, and only once", async () => {
    await request(); await makeReady();
    const res = await post("/api/v1/key-recovery/complete", { password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ phrase: PHRASE });
    expect(res.headers["cache-control"]).toContain("no-store");
    expect((await post("/api/v1/key-recovery/complete", { password: PASSWORD })).statusCode).toBe(404);
    expect(await recoveryFreezeActive(1)).toBe(false);
    const actions = (await auditRows()).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["key_recovery_requested", "wallet_key_escrow_open", "key_recovery_completed"]));
  });

  it("refuses before the wait is over, and keeps waiting", async () => {
    await request();
    const res = await post("/api/v1/key-recovery/complete", { password: PASSWORD });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain("illness");
    expect((await get("/api/v1/key-recovery/status")).json().state).toBe("waiting");
  });

  it("refuses a wrong password without using up the request", async () => {
    await request(); await makeReady();
    expect((await post("/api/v1/key-recovery/complete", { password: "nope nope nope" })).statusCode).toBe(403);
    expect((await get("/api/v1/key-recovery/status")).json().state).toBe("ready");
  });

  it("refuses when nothing was requested, for a cancelled request, and for another user", async () => {
    expect((await post("/api/v1/key-recovery/complete", { password: PASSWORD })).statusCode).toBe(404);
    await request(); await makeReady();
    await post("/api/v1/key-recovery/cancel", {});
    expect((await post("/api/v1/key-recovery/complete", { password: PASSWORD })).statusCode).toBe(404);
    await request(); await makeReady();
    state.userId = 2;
    expect((await post("/api/v1/key-recovery/complete", { password: PASSWORD })).statusCode).toBe(404);
  });
});

describe("what never leaks", () => {
  it("keeps the code, the token, the password and the phrase out of logs and audit rows", async () => {
    const logged: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logged.push(a.map(String).join(" ")); });
    const code = await sendCode();
    await post("/api/v1/key-recovery/request", { password: PASSWORD, code });
    const token = tokenFromAlert();
    await makeReady();
    await post("/api/v1/key-recovery/complete", { password: "wrong wrong wrong" });
    await post("/api/v1/key-recovery/complete", { password: PASSWORD });
    const text = logged.join("\n") + JSON.stringify(await auditRows());
    for (const secret of [code, token, PASSWORD, "illness"]) expect(text).not.toContain(secret);
    vi.restoreAllMocks();
  });
});
