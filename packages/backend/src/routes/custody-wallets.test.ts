import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { applyCustodyV3 } from "../db/migrations/custody-v3";
import { applyCustodyV4 } from "../db/migrations/custody-v4";
import { LocalMasterKeyProvider, openFromEscrow, sealForEscrow } from "../lib/key-wrapper";
import { deriveAllChains } from "../lib/one-phrase";
import type { CustodyFlags } from "../lib/custody-flags";

// Multiple derived wallets per chain (testnet): list, add, rename and choose the main wallet.
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1 }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet" } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));

import { custodyRoutes } from "./custody";

const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const flagsAllOff: CustodyFlags = { serverSigning: false, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 5 };
const flagsOn: CustodyFlags = { ...flagsAllOff, serverSigning: true };
const WORDS12 = /\b([a-z]{3,8} ){11}[a-z]{3,8}\b/;
let pg: PGlite;
let app: FastifyInstance;
let gated: FastifyInstance;
let noProvider: FastifyInstance;
const count = async (t: string) => (await pg.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as { n: number };
const onboard = () => app.inject({ method: "POST", url: "/api/v1/custody/onboard" });
const list = (a = app) => a.inject({ method: "GET", url: "/api/v1/custody/wallets" });
const add = (body: any, a = app) => a.inject({ method: "POST", url: "/api/v1/custody/wallets", payload: body });
const patch = (body: any, a = app) => a.inject({ method: "PATCH", url: "/api/v1/custody/wallets", payload: body });
const phrase = async () => {
  const [row] = (await pg.query("SELECT sealed FROM wallet_key_escrow WHERE user_id=1 AND kind='phrase'")).rows as { sealed: string }[];
  return openFromEscrow(provider, row.sealed, { userId: 1, kind: "phrase", reason: "test" });
};

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  await applyKeyEscrow(conn); await applyCustody(conn); await applyCustodyV2(conn); await applyCustodyV3(conn); await applyCustodyV4(conn);
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  app = Fastify(); await app.register(custodyRoutes, { provider, flags: flagsOn }); await app.ready();
  gated = Fastify(); await gated.register(custodyRoutes, { provider, flags: flagsAllOff }); await gated.ready();
  noProvider = Fastify(); await noProvider.register(custodyRoutes, { provider: null, flags: flagsOn }); await noProvider.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1;
  await pg.exec("TRUNCATE wallet_key_escrow; TRUNCATE welcome_funding; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
});
afterAll(async () => { await app?.close(); await gated?.close(); await noProvider?.close(); await pg?.close(); });

describe("custody multiple wallets", () => {
  it("onboarding records derivation index 0 on all three rows, and the list shows them", async () => {
    await onboard();
    const rows = (await pg.query("SELECT derivation_index FROM user_wallets WHERE user_id=1")).rows as any[];
    expect(rows.map((r) => r.derivation_index)).toEqual([0, 0, 0]);
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json().wallets.map((w: any) => [w.chain, w.network, w.index, w.active])).toEqual([
      ["evm", "sepolia", 0, true], ["stellar", "testnet", 0, true], ["xrpl", "testnet", 0, true]]);
  });

  it("adds XRP and ETH wallets that match the phrase at each index, inactive, named, never returning the phrase", async () => {
    await onboard();
    const p = await phrase();
    const x = await add({ chain: "xrpl" });
    expect(x.statusCode).toBe(200);
    expect(x.body).not.toMatch(WORDS12);
    expect(x.json().wallet).toMatchObject({ chain: "xrpl", network: "testnet", address: deriveAllChains(p, 1).xrpl.address, name: "Wallet 2", index: 1, active: false });
    const e = await add({ chain: "evm", name: "  Savings  " });
    expect(e.json().wallet).toMatchObject({ chain: "evm", network: "sepolia", address: deriveAllChains(p, 1).evm.address, name: "Savings", index: 1, active: false });
    const audit = (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as any[];
    expect(audit.filter((a) => a.action === "custody_wallet_added").map((a) => a.detail)).toEqual([{ chain: "xrpl", index: 1 }, { chain: "evm", index: 1 }]);
    expect(audit.filter((a) => a.action === "wallet_key_escrow_open" && a.detail.reason !== "test").map((a) => a.detail.reason)).toEqual(["custody-add-wallet:xrpl:1", "custody-add-wallet:evm:1"]);
    expect(JSON.stringify(audit)).not.toMatch(WORDS12);
    const l = (await list()).json().wallets;
    expect(l.map((w: any) => [w.chain, w.index])).toEqual([["evm", 0], ["evm", 1], ["stellar", 0], ["xrpl", 0], ["xrpl", 1]]);
    expect(l.filter((w: any) => w.active).map((w: any) => [w.chain, w.index])).toEqual([["evm", 0], ["stellar", 0], ["xrpl", 0]]);
    expect((await list()).body).not.toMatch(WORDS12);
  });

  it("allows 10 wallets per network and refuses the 11th", { timeout: 60_000 }, async () => {
    await onboard();
    const p = await phrase();
    for (let n = 1; n <= 9; n++) {
      const r = await add({ chain: "xrpl" });
      expect(r.statusCode).toBe(200);
      expect(r.json().wallet.address).toBe(deriveAllChains(p, n).xrpl.address);
    }
    const eleventh = await add({ chain: "xrpl" });
    expect(eleventh.statusCode).toBe(409);
    expect(eleventh.json()).toEqual({ error: "You can have up to 10 wallets on this network." });
    expect(await count("user_wallets")).toEqual({ n: 3 + 9 });
    expect((await add({ chain: "evm" })).statusCode).toBe(200);
  });

  it("gives distinct indexes to concurrent adds", async () => {
    await onboard();
    const results = await Promise.all([1, 2, 3].map(() => add({ chain: "evm" })));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(results.map((r) => r.json().wallet.index).sort()).toEqual([1, 2, 3]);
  });

  it("refuses self-custody (409), a flag that is off or no provider (503), missing escrow (409) and bad input (400)", async () => {
    await onboard();
    await pg.exec("UPDATE users SET signing_mode='self'");
    expect((await add({ chain: "xrpl" })).statusCode).toBe(409);
    expect((await list()).statusCode).toBe(409);
    expect((await patch({ chain: "xrpl", address: "r", name: "x" })).statusCode).toBe(409);
    await pg.exec("UPDATE users SET signing_mode='delegated'");
    expect((await add({ chain: "xrpl" }, gated)).statusCode).toBe(503);
    expect((await list(gated)).statusCode).toBe(503);
    expect((await patch({ chain: "xrpl", address: "r", name: "x" }, gated)).statusCode).toBe(503);
    expect((await add({ chain: "xrpl" }, noProvider)).statusCode).toBe(503);
    expect((await add({ chain: "stellar" })).statusCode).toBe(400);
    expect((await add({ chain: "xrpl", name: "x".repeat(41) })).statusCode).toBe(400);
    expect((await add({ chain: "xrpl", name: "   " })).statusCode).toBe(400);
    expect((await add({ chain: "xrpl", name: 5 })).statusCode).toBe(400);
    await pg.exec("TRUNCATE wallet_key_escrow");
    expect((await add({ chain: "xrpl" })).statusCode).toBe(409);
  });

  it("does not add a wallet for a phrase the client uploaded (origin client)", async () => {
    await onboard();
    await pg.exec("UPDATE wallet_key_escrow SET origin='client'");
    expect((await add({ chain: "xrpl" })).statusCode).toBe(409);
    expect((await list()).statusCode).toBe(409);
    expect(await count("user_wallets")).toEqual({ n: 3 });
  });

  it("renames and swaps the active wallet, leaving exactly one active per chain and network", async () => {
    await onboard();
    const second = (await add({ chain: "xrpl" })).json().wallet;
    const first = (await list()).json().wallets.find((w: any) => w.chain === "xrpl" && w.index === 0);
    const r = await patch({ chain: "xrpl", address: second.address, name: "Trading", active: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().wallet).toMatchObject({ address: second.address, name: "Trading", active: true });
    let x = (await list()).json().wallets.filter((w: any) => w.chain === "xrpl");
    expect(x.map((w: any) => [w.index, w.active, w.name])).toEqual([[0, false, "Amma XRP"], [1, true, "Trading"]]);
    await patch({ chain: "xrpl", address: first.address, active: true });
    x = (await list()).json().wallets.filter((w: any) => w.chain === "xrpl");
    expect(x.map((w: any) => [w.index, w.active, w.name])).toEqual([[0, true, "Amma XRP"], [1, false, "Trading"]]);
    expect((await list()).json().wallets.filter((w: any) => w.chain === "evm" && w.active)).toHaveLength(1);
    expect((await pg.query("SELECT action FROM audit_logs WHERE action='custody_wallet_updated'")).rows).toHaveLength(2);
  });

  it("validates PATCH input and only touches the user's own custody rows", async () => {
    await onboard();
    const mine = (await list()).json().wallets.find((w: any) => w.chain === "evm");
    expect((await patch({ chain: "evm", address: mine.address, name: "" })).statusCode).toBe(400);
    expect((await patch({ chain: "evm", address: mine.address, name: "y".repeat(41) })).statusCode).toBe(400);
    expect((await patch({ chain: "evm", address: mine.address, active: false })).statusCode).toBe(400);
    expect((await patch({ chain: "evm", address: mine.address })).statusCode).toBe(400);
    expect((await patch({ chain: "bitcoin", address: "G", name: "n" })).statusCode).toBe(400);
    expect((await patch({ chain: "stellar", address: "G", name: "n" })).statusCode).toBe(404);
    expect((await patch({ chain: "evm", address: "0xnot-mine", name: "n" })).statusCode).toBe(404);
    expect((await patch({ chain: "evm", address: mine.address.toLowerCase(), name: "Lower" })).statusCode).toBe(200);
    await pg.exec("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'xrpl','testnet','rIMPORTED','imp',false), (2,'xrpl','testnet','rTHEIRS','t',true)");
    expect((await patch({ chain: "xrpl", address: "rIMPORTED", active: true })).statusCode).toBe(404);
    expect((await patch({ chain: "xrpl", address: "rTHEIRS", name: "mine now" })).statusCode).toBe(404);
    expect((await pg.query("SELECT name FROM user_wallets WHERE public_key='rTHEIRS'")).rows).toEqual([{ name: "t" }]);
  });

  it("rejects control and bidi-override characters in names", async () => {
    await onboard();
    const mine = (await list()).json().wallets.find((w: any) => w.chain === "evm");
    const bad = ["a" + String.fromCharCode(0) + "b", "a" + String.fromCharCode(10) + "b", "x" + String.fromCharCode(0x202E) + "y", "x" + String.fromCharCode(0x2066) + "y"];
    for (const name of bad) {
      expect((await add({ chain: "xrpl", name })).statusCode).toBe(400);
      expect((await patch({ chain: "evm", address: mine.address, name })).statusCode).toBe(400);
    }
    expect((await add({ chain: "xrpl", name: "Caf" + String.fromCharCode(0xe9) })).statusCode).toBe(200);
  });

  it("answers 409 without an address when the new wallet already exists", async () => {
    await onboard();
    const p = await phrase();
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'xrpl','testnet',$1,'pre',false)", [deriveAllChains(p, 1).xrpl.address]);
    const r = await add({ chain: "xrpl" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "That wallet already exists on your account." });
  });

  it("lists only testnet and sepolia custody rows", async () => {
    await onboard();
    await pg.exec("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'xrpl','mainnet','rMAIN','m',false,3)");
    expect((await list()).json().wallets.some((w: any) => w.address === "rMAIN")).toBe(false);
  });

  const IMP_KIND = "import:stellar:GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H" as const;
  it("does not list derived rows when Amma holds no custody phrase (only wallets moved in)", async () => {
    await onboard();
    const stellar = ((await pg.query("SELECT public_key FROM user_wallets WHERE chain='stellar'")).rows[0] as { public_key: string }).public_key;
    await pg.exec("UPDATE wallet_key_escrow SET origin='client'");
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'stellar','testnet','GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H','imp',false)");
    await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,$1,$2,'local','import')", [IMP_KIND, await sealForEscrow(provider, "SECRET", { userId: 1, kind: IMP_KIND })]);
    const addresses = (await list()).json().wallets.map((w: any) => w.address);
    expect(addresses).toEqual(["GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"]);
    expect(addresses).not.toContain(stellar);
  });

  it("shows the new audit actions in the activity list", async () => {
    await onboard();
    await add({ chain: "xrpl" });
    const ev = (await app.inject({ method: "GET", url: "/api/v1/custody/activity" })).json().events;
    expect(ev.map((e: any) => e.action)).toContain("custody_wallet_added");
  });
});
