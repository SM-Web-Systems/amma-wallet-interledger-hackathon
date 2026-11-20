import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { LocalMasterKeyProvider, openFromEscrow } from "../lib/key-wrapper";
import { deriveAllChains } from "../lib/one-phrase";
import type { CustodyFlags } from "../lib/custody-flags";
import { setAppLogger } from "../lib/app-log";

// Stage 0 custody: zero-setup onboarding (one sealed phrase, three testnet wallets), key-use activity, welcome funding list.
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1 }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet" } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));

import { custodyRoutes } from "./custody";

const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const flagsAllOff: CustodyFlags = { serverSigning: false, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 5 };
const flagsOff: CustodyFlags = { ...flagsAllOff, serverSigning: true };
const flagsOn: CustodyFlags = { ...flagsOff, welcomeFunding: true };
const WORDS12 = /\b([a-z]{3,8} ){11}[a-z]{3,8}\b/;
let pg: PGlite;
let app: FastifyInstance;
let funded: FastifyInstance;
let off: FastifyInstance;
let gated: FastifyInstance;
let fundingOnly: FastifyInstance;
const queue = vi.fn(async (_u: number, _w: { stellar: string; xrpl: string; evm: string }) => {});
const retry = vi.fn(async (_u: number) => {});
const onboard = (a = app) => a.inject({ method: "POST", url: "/api/v1/custody/onboard" });
const count = async (t: string) => (await pg.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as { n: number };

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  await applyKeyEscrow(conn); await applyCustody(conn); await applyCustodyV2(conn);
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  app = Fastify(); await app.register(custodyRoutes, { provider, flags: flagsOff, queueFunding: queue }); await app.ready();
  funded = Fastify(); await funded.register(custodyRoutes, { provider, flags: flagsOn, queueFunding: queue, retryFunding: retry }); await funded.ready();
  off = Fastify(); await off.register(custodyRoutes, { provider: null, flags: flagsOff }); await off.ready();
  gated = Fastify(); await gated.register(custodyRoutes, { provider, flags: flagsAllOff, queueFunding: queue }); await gated.ready();
  fundingOnly = Fastify(); await fundingOnly.register(custodyRoutes, { provider, flags: { ...flagsAllOff, welcomeFunding: true }, queueFunding: queue, retryFunding: retry }); await fundingOnly.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1; queue.mockClear(); retry.mockClear();
  await pg.exec("TRUNCATE wallet_key_escrow; TRUNCATE welcome_funding; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
});
afterAll(async () => { await app?.close(); await funded?.close(); await off?.close(); await gated?.close(); await fundingOnly?.close(); await pg?.close(); });

describe("custody onboarding", () => {
  it("creates one sealed phrase and three testnet wallets that match it, and never returns the phrase", async () => {
    const res = await onboard();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).not.toMatch(WORDS12);
    const body = res.json();
    expect(body.created).toBe(true);
    expect(body.funding).toBe("off");
    const [row] = (await pg.query("SELECT sealed FROM wallet_key_escrow WHERE user_id=1 AND kind='phrase'")).rows as { sealed: string }[];
    const phrase = await openFromEscrow(provider, row.sealed, { userId: 1, kind: "phrase", reason: "test" });
    const d = deriveAllChains(phrase);
    expect(body.wallets).toEqual({ stellar: d.stellar.publicKey, xrpl: d.xrpl.address, evm: d.evm.address });
    const wallets = (await pg.query("SELECT chain, network, public_key, is_active, encrypted_secret FROM user_wallets WHERE user_id=1 ORDER BY chain")).rows as any[];
    expect(wallets).toEqual([
      { chain: "evm", network: "sepolia", public_key: d.evm.address, is_active: true, encrypted_secret: null },
      { chain: "stellar", network: "testnet", public_key: d.stellar.publicKey, is_active: true, encrypted_secret: null },
      { chain: "xrpl", network: "testnet", public_key: d.xrpl.address, is_active: true, encrypted_secret: null },
    ]);
    const audit = (await pg.query("SELECT action, detail FROM audit_logs")).rows as any[];
    expect(audit.map((a) => a.action)).toContain("custody_onboard");
    expect(JSON.stringify(audit)).not.toMatch(WORDS12);
  });

  it("answers created:false on a second call and adds no rows", async () => {
    const first = (await onboard()).json();
    const second = await onboard();
    expect(second.json()).toEqual({ created: false, wallets: first.wallets });
    expect(await count("wallet_key_escrow")).toEqual({ n: 1 });
    expect(await count("user_wallets")).toEqual({ n: 3 });
  });

  it("makes exactly one escrow row when two calls race", async () => {
    const [a, b] = await Promise.all([onboard(), onboard()]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await count("wallet_key_escrow")).toEqual({ n: 1 });
    expect(await count("user_wallets")).toEqual({ n: 3 });
    expect(a.json().wallets).toEqual(b.json().wallets);
  });

  it("leaves an existing active wallet active and adds the new one inactive", async () => {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'stellar','testnet','GEXISTING','Mine',true)");
    await onboard();
    const rows = (await pg.query("SELECT public_key, is_active FROM user_wallets WHERE user_id=1 AND chain='stellar'")).rows as any[];
    expect(rows.filter((r) => r.is_active).map((r) => r.public_key)).toEqual(["GEXISTING"]);
    expect(rows).toHaveLength(2);
  });

  it("is not switched on unless a custody flag is on, and writes nothing", async () => {
    const res = await onboard(gated);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Amma wallet setup is not switched on here yet." });
    expect(await count("wallet_key_escrow")).toEqual({ n: 0 });
    expect(await count("user_wallets")).toEqual({ n: 0 });
  });

  it("needs server signing: welcome funding alone does not switch onboarding on", async () => {
    const res = await onboard(fundingOnly);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Amma wallet setup is not switched on here yet." });
    expect(await count("wallet_key_escrow")).toEqual({ n: 0 });
    expect(queue).not.toHaveBeenCalled();
  });

  it("refuses self-custody users with 409 and no provider with 503", async () => {
    await pg.query("UPDATE users SET signing_mode='self' WHERE id=1");
    expect((await onboard()).statusCode).toBe(409);
    expect(await count("wallet_key_escrow")).toEqual({ n: 0 });
    expect((await onboard(off)).statusCode).toBe(503);
  });

  it("queues welcome funding once when on, never when off, and survives a queue failure", async () => {
    await onboard(app);
    expect(queue).not.toHaveBeenCalled();
    state.userId = 2;
    const res = await onboard(funded);
    expect(res.json().funding).toBe("queued");
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledWith(2, res.json().wallets);
    expect(Object.keys(queue.mock.calls[0][1]).sort()).toEqual(["evm", "stellar", "xrpl"]);
    await pg.exec("TRUNCATE wallet_key_escrow; DELETE FROM user_wallets");
    state.userId = 2;
    const rec: string[] = []; setAppLogger({ info: (o, m) => rec.push(JSON.stringify([o, m])), warn: (o, m) => rec.push(JSON.stringify([o, m])), error: (o, m) => rec.push(JSON.stringify([o, m])) });
    queue.mockRejectedValueOnce(new Error("boom"));
    const res2 = await onboard(funded);
    expect(res2.statusCode).toBe(200);
    const logged = JSON.stringify(rec);
    setAppLogger(null);
    expect(rec.length).toBeGreaterThan(0);
    expect(logged).not.toMatch(WORDS12);
    for (const address of Object.values(res2.json().wallets) as string[]) expect(logged).not.toContain(address);
  });
});

describe("custody activity", () => {
  it("lists only the user's own whitelisted events, with only whitelisted detail", async () => {
    await pg.query(`INSERT INTO audit_logs (user_id, action, detail) VALUES
      (1,'wallet_custody_sign','{"chain":"xrpl","reason":"payment","phrase":"secret words","address":"rX"}'),
      (1,'login','{"chain":"xrpl"}'),
      (2,'wallet_custody_sign','{"chain":"evm"}'),
      (1,'key_recovery_requested','{}')`);
    const res = await app.inject({ method: "GET", url: "/api/v1/custody/activity" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    const events = res.json().events as any[];
    expect(events.map((e) => e.action).sort()).toEqual(["key_recovery_requested", "wallet_custody_sign"]);
    const sign = events.find((e) => e.action === "wallet_custody_sign");
    expect(sign).toMatchObject({ chain: "xrpl", reason: "payment" });
    expect(Object.keys(sign).sort()).toEqual(["action", "at", "chain", "reason"]);
    expect(res.body).not.toContain("secret words");
  });
});

describe("flag-gated status routes", () => {
  it("answer 503 on activity and welcome-funding when both flags are off", async () => {
    for (const url of ["/api/v1/custody/activity", "/api/v1/custody/welcome-funding"]) {
      const res = await gated.inject({ method: "GET", url });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Amma wallet setup is not switched on here yet." });
    }
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("welcome funding list", () => {
  it("lists the user's own rows", async () => {
    await pg.query(`INSERT INTO welcome_funding (user_id, chain, address, state, amount, reference, error) VALUES
      (1,'stellar','GA','confirmed','10','abc',NULL),(2,'evm','0x1','queued',NULL,NULL,NULL)`);
    const res = await app.inject({ method: "GET", url: "/api/v1/custody/welcome-funding" });
    expect(res.json().funding).toEqual([{ chain: "stellar", address: "GA", state: "confirmed", amount: "10", reference: "abc", error: null }]);
    expect(queue).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  });
  it("kicks a retry once, without waiting, and still returns the rows", async () => {
    await pg.query(`INSERT INTO welcome_funding (user_id, chain, address, state) VALUES (1,'evm','0x1','failed')`);
    let release!: () => void;
    retry.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const res = await funded.inject({ method: "GET", url: "/api/v1/custody/welcome-funding" });
    expect(retry).toHaveBeenCalledTimes(1); expect(retry).toHaveBeenCalledWith(1); expect(queue).not.toHaveBeenCalled();
    expect(res.json().funding).toHaveLength(1);
    release();
  });
});
