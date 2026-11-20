import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { LocalMasterKeyProvider } from "../lib/key-wrapper";
import speakeasy from "speakeasy";
import crypto from "node:crypto";

// Managed wallet (custody plan, step 2): Amma keeps one sealed recovery phrase per user, which only the
// signed-in owner can read back, after typing their account password again.
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1 }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet", TOTP_ENCRYPTION_KEY: "11".repeat(32) } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));

import { keyEscrowRoutes, type EscrowMail } from "./key-escrow";
import { encryptTotpSecret } from "../lib/totp-crypto";
import { hashEmailCode } from "../lib/code-hash";

// Every read-back emails the owner first; tests record the emails instead of sending them.
const sent = { viewed: [] as string[], codes: [] as { to: string; code: string }[], failViewed: false };
const mail: EscrowMail = {
  viewed: async (to) => { if (sent.failViewed) throw new Error("smtp down"); sent.viewed.push(to); },
  code: async (to, code) => { sent.codes.push({ to, code }); },
};

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PASSWORD = "correct horse battery staple";
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 5).toString("base64"));
let pg: PGlite;
let app: FastifyInstance;
let off: FastifyInstance;
let closed: FastifyInstance;
const closedRoutes: string[] = [];
const auditRows = async () => (await pg.query("SELECT user_id, action, detail FROM audit_logs ORDER BY id")).rows as { user_id: number; action: string; detail: any }[];
const put = (phrase: unknown, a = app) => a.inject({ method: "PUT", url: "/api/v1/key-escrow/phrase", payload: { phrase } });
const open = (password: unknown, a = app, twoFaToken?: string) => a.inject({ method: "POST", url: "/api/v1/key-escrow/phrase/open", payload: { password, ...(twoFaToken !== undefined ? { twoFaToken } : {}) } });

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  await applyKeyEscrow({ execute: async (s) => { await pg.exec(s); }, rows: async (s) => (await pg.query(s)).rows as any });
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  await pg.query("UPDATE users SET password_hash=$1 WHERE id IN (1,2)", [await bcrypt.hash(PASSWORD, 4)]);
  await pg.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_secret text, ADD COLUMN IF NOT EXISTS two_fa_enabled boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS two_fa_method text DEFAULT 'none', ADD COLUMN IF NOT EXISTS two_fa_backup_codes text, ADD COLUMN IF NOT EXISTS two_fa_static_code text;
    CREATE TABLE IF NOT EXISTS email_codes (id bigserial PRIMARY KEY, user_id bigint NOT NULL, code text NOT NULL, type text NOT NULL DEFAULT 'login',
      expires_at timestamptz NOT NULL, used boolean DEFAULT false, created_at timestamptz DEFAULT now())`);
  state.db = drizzle(pg);
  app = Fastify(); await app.register(keyEscrowRoutes, { provider, openEnabled: true, mail }); await app.ready();
  // The default build: the flag is not set, as on a deployment that never turned it on.
  delete process.env.KEY_ESCROW_OPEN_ENABLED;
  closed = Fastify(); closed.addHook("onRoute", (route) => { closedRoutes.push(`${String(route.method)} ${route.url}`); });
  await closed.register(keyEscrowRoutes, { provider, mail }); await closed.ready();
  off = Fastify(); await off.register(keyEscrowRoutes, { provider: null, openEnabled: true, mail }); await off.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1;
  await pg.exec("TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; TRUNCATE email_codes; UPDATE users SET signing_mode='delegated', two_fa_enabled=false, two_fa_method='none', two_fa_secret=NULL, two_fa_backup_codes=NULL, two_fa_static_code=NULL, email=CASE id WHEN 1 THEN 'one@example.invalid' ELSE 'two@example.invalid' END");
  sent.viewed = []; sent.codes = []; sent.failViewed = false;
});
afterAll(async () => { await app?.close(); await closed?.close(); await off?.close(); await pg?.close(); });

describe("phrase open route is off by default (G-01 step A)", () => {
  it("returns 404 and writes no audit row when KEY_ESCROW_OPEN_ENABLED is not set", async () => {
    expect((await put(PHRASE, closed)).statusCode).toBe(200);
    const res = await open(PASSWORD, closed);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(PHRASE);
    expect((await auditRows()).filter((r) => /open/.test(r.action))).toEqual([]);
  });

  it("registers no route that hands a phrase back, only the allow-listed ones", () => {
    const allowed = ["GET /api/v1/key-escrow/status", "PUT /api/v1/key-escrow/phrase"];
    const registered = closedRoutes.filter((r) => !r.startsWith("HEAD"));
    expect(registered.sort()).toEqual(allowed.sort());
  });

  it("is on only when the flag is exactly true", async () => {
    process.env.KEY_ESCROW_OPEN_ENABLED = "yes";
    const a = Fastify(); await a.register(keyEscrowRoutes, { provider, mail }); await a.ready();
    expect((await open(PASSWORD, a)).statusCode).toBe(404);
    await a.close();
    process.env.KEY_ESCROW_OPEN_ENABLED = "true";
    const b = Fastify(); await b.register(keyEscrowRoutes, { provider, mail }); await b.ready();
    expect((await put(PHRASE, b)).statusCode).toBe(200);
    expect((await open(PASSWORD, b)).statusCode).toBe(200);
    await b.close();
    delete process.env.KEY_ESCROW_OPEN_ENABLED;
  });
});

describe("key escrow routes", () => {
  it("saves a phrase sealed, and gives it back to its owner after the password is typed again", async () => {
    expect((await put(PHRASE)).statusCode).toBe(200);
    const res = await open(PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ phrase: PHRASE });
    expect(res.headers["cache-control"]).toContain("no-store");
  });

  it("never stores the phrase in readable form", async () => {
    await put(PHRASE);
    const [row] = (await pg.query("SELECT sealed FROM wallet_key_escrow")).rows as { sealed: string }[];
    expect(row.sealed).not.toContain(PHRASE);
    // The sealed value is random base64, so a 3-4 letter word ("fit", "toe") turns up by chance now and then.
    // Words of 5+ letters still catch a readable phrase without that flake (well under 1 in 100,000 per run).
    for (const word of PHRASE.split(" ").filter((w) => w.length >= 5)) expect(row.sealed.toLowerCase()).not.toContain(word);
  });

  it("accepts a pasted phrase with capitals and extra spaces, and stores the clean form", async () => {
    await put(`  ${PHRASE.toUpperCase().replace(/ /g, "   ")} \n`);
    expect((await open(PASSWORD)).json()).toEqual({ phrase: PHRASE });
  });

  it("replaces an earlier phrase", async () => {
    await put(PHRASE);
    await put("legal winner thank year wave sausage worth useful legal winner thank yellow");
    expect((await open(PASSWORD)).json().phrase).toContain("legal winner");
    expect((await pg.query("SELECT count(*)::int AS n FROM wallet_key_escrow")).rows[0]).toEqual({ n: 1 });
  });

  it("refuses text that is not a valid 12 or 24 word phrase, without echoing it", async () => {
    for (const bad of ["not a phrase", "abandon ".repeat(12).trim(), "", 42, null, undefined]) {
      const res = await put(bad);
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain("abandon");
    }
    expect((await pg.query("SELECT count(*)::int AS n FROM wallet_key_escrow")).rows[0]).toEqual({ n: 0 });
  });

  it("refuses the read when the password is wrong, and records the refusal", async () => {
    await put(PHRASE);
    const res = await open("wrong password here");
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("illness");
    expect((await auditRows()).map((r) => r.action)).toContain("wallet_key_escrow_denied");
  });

  it("refuses a missing password", async () => {
    await put(PHRASE);
    expect((await open(undefined)).statusCode).toBe(400);
  });

  it("does not give one user's phrase to another", async () => {
    await put(PHRASE);
    state.userId = 2;
    expect((await open(PASSWORD)).statusCode).toBe(404);
  });

  it("says 404 when no phrase is stored", async () => {
    expect((await open(PASSWORD)).statusCode).toBe(404);
  });

  it("leaves self-custody users alone: nothing is saved or read", async () => {
    await pg.query("UPDATE users SET signing_mode='self' WHERE id=1");
    expect((await put(PHRASE)).statusCode).toBe(409);
    await pg.query("UPDATE users SET signing_mode='delegated' WHERE id=1");
    await put(PHRASE);
    await pg.query("UPDATE users SET signing_mode='self' WHERE id=1");
    expect((await open(PASSWORD)).statusCode).toBe(409);
  });

  it("reports whether a phrase is backed up, without revealing anything", async () => {
    expect((await app.inject({ method: "GET", url: "/api/v1/key-escrow/status" })).json()).toEqual({ enabled: true, hasPhrase: false });
    await put(PHRASE);
    const res = await app.inject({ method: "GET", url: "/api/v1/key-escrow/status" });
    expect(res.json()).toEqual({ enabled: true, hasPhrase: true });
    expect(res.body).not.toContain("illness");
  });

  it("keeps today's replace behaviour on a database without the custody origin column", async () => {
    await put(PHRASE);
    expect((await put("legal winner thank year wave sausage worth useful legal winner thank yellow")).statusCode).toBe(200);
  });

  it("with custody-v1 applied: a custodial row survives a save even with no audit row, client rows still replace", async () => {
    await pg.exec("ALTER TABLE wallet_key_escrow ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'client'");
    await put(PHRASE);
    expect((await put("legal winner thank year wave sausage worth useful legal winner thank yellow")).statusCode).toBe(200);
    await pg.query("UPDATE wallet_key_escrow SET origin='custody'");
    const before = (await pg.query("SELECT sealed FROM wallet_key_escrow")).rows;
    const res = await put(PHRASE);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Amma already keeps the recovery phrase for your wallets." });
    expect((await pg.query("SELECT sealed FROM wallet_key_escrow")).rows).toEqual(before);
    state.userId = 2;
    expect((await put(PHRASE)).statusCode).toBe(200);
  });

  it("is off, and says so, until a master key provider is configured", async () => {
    expect((await put(PHRASE, off)).statusCode).toBe(503);
    expect((await open(PASSWORD, off)).statusCode).toBe(503);
    expect((await off.inject({ method: "GET", url: "/api/v1/key-escrow/status" })).json()).toEqual({ enabled: false, hasPhrase: false });
  });

  it("audits save and open with the user and kind, never the phrase or the password", async () => {
    await put(PHRASE); await open(PASSWORD);
    const rows = await auditRows();
    expect(rows.map((r) => r.action)).toEqual(["wallet_key_escrow_save", "wallet_key_escrow_open"]);
    expect(rows.every((r) => r.user_id === 1)).toBe(true);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("illness");
    expect(text).not.toContain(PASSWORD);
  });
});

describe("phrase read-back: second factor and owner alert (audit 2026-11-18)", () => {
  const TOTP = speakeasy.generateSecret({ length: 20 }).base32;
  const enrolTotp = () => pg.query("UPDATE users SET two_fa_enabled=true, two_fa_method='totp', two_fa_secret=$1 WHERE id=1", [encryptTotpSecret(TOTP)]);

  it("emails the owner before the phrase is released", async () => {
    await put(PHRASE);
    expect((await open(PASSWORD)).json()).toEqual({ phrase: PHRASE });
    expect(sent.viewed).toEqual(["one@example.invalid"]);
  });

  it("releases nothing when the alert email cannot be sent, and records why", async () => {
    await put(PHRASE); sent.failViewed = true;
    const res = await open(PASSWORD);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("illness");
    expect((await auditRows()).map((r) => [r.action, r.detail.why])).toContainEqual(["wallet_key_escrow_denied", "alert-not-sent"]);
    expect((await auditRows()).some((r) => r.action === "wallet_key_escrow_open")).toBe(false);
  });

  it("refuses an account with no email address", async () => {
    await put(PHRASE); await pg.exec("ALTER TABLE users ALTER COLUMN email DROP NOT NULL; UPDATE users SET email=NULL WHERE id=1");
    const res = await open(PASSWORD);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("illness");
  });

  it("asks an enrolled user for their authenticator code, then accepts a valid one", async () => {
    await put(PHRASE); await enrolTotp();
    const ask = await open(PASSWORD);
    expect(ask.statusCode).toBe(200);
    expect(ask.json()).toEqual({ twoFaRequired: true, twoFaMethod: "totp" });
    expect(sent.viewed).toEqual([]);
    const token = speakeasy.totp({ secret: TOTP, encoding: "base32" });
    expect((await open(PASSWORD, app, token)).json()).toEqual({ phrase: PHRASE });
    expect(sent.viewed).toEqual(["one@example.invalid"]);
  });

  it("refuses a wrong code, sends no alert and records the refusal", async () => {
    await put(PHRASE); await enrolTotp();
    const res = await open(PASSWORD, app, "000000");
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("illness");
    expect(sent.viewed).toEqual([]);
    expect((await auditRows()).map((r) => [r.action, r.detail.why])).toContainEqual(["wallet_key_escrow_denied", "second-factor"]);
  });

  it("checks the password before the second factor", async () => {
    await put(PHRASE); await enrolTotp();
    const res = await open("wrong password", app, speakeasy.totp({ secret: TOTP, encoding: "base32" }));
    expect(res.statusCode).toBe(403);
    expect((await auditRows()).map((r) => r.detail.why)).toContain("password");
  });

  it("email method: emails a one-time code of its own purpose, accepts it once", async () => {
    await put(PHRASE); await pg.exec("UPDATE users SET two_fa_enabled=true, two_fa_method='email' WHERE id=1");
    expect((await open(PASSWORD)).json()).toEqual({ twoFaRequired: true, twoFaMethod: "email" });
    expect(sent.codes).toHaveLength(1);
    const { code } = sent.codes[0];
    expect((await open(PASSWORD, app, code)).json()).toEqual({ phrase: PHRASE });
    expect((await open(PASSWORD, app, code)).statusCode).toBe(403);
  });

  it("does not accept a sign-in email code for a read-back", async () => {
    await put(PHRASE); await pg.exec("UPDATE users SET two_fa_enabled=true, two_fa_method='email' WHERE id=1");
    await pg.query("INSERT INTO email_codes (user_id, code, type, expires_at) VALUES (1, $1, 'login', now() + interval '5 minutes')", [hashEmailCode("123456")]);
    expect((await open(PASSWORD, app, "123456")).statusCode).toBe(403);
  });

  it("accepts a backup code once", async () => {
    await put(PHRASE); await enrolTotp();
    const backup = "ABCD1234";
    await pg.query("UPDATE users SET two_fa_backup_codes=$1 WHERE id=1", [JSON.stringify([crypto.createHash("sha256").update(backup).digest("hex")])]);
    expect((await open(PASSWORD, app, backup.toLowerCase())).json()).toEqual({ phrase: PHRASE });
    expect((await open(PASSWORD, app, backup)).statusCode).toBe(403);
  });
});
