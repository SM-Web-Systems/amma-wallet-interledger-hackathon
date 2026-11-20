import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { Keypair } from "@stellar/stellar-sdk";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { applyCustodyV3 } from "../db/migrations/custody-v3";
import { applyCustodyV4 } from "../db/migrations/custody-v4";
import { LocalMasterKeyProvider, sealForEscrow } from "../lib/key-wrapper";
import { deriveAllChains } from "../lib/one-phrase";
import { importKind } from "../lib/custody-import";
import { setAppLogger } from "../lib/app-log";
import { LMS_CLAIM_PREFIX } from "../lib/lms-claim";
import type { CustodyFlags } from "../lib/custody-flags";

const state = vi.hoisted(() => ({ db: undefined as any, userId: 1, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "public", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y", JWT_EXPIRES_IN: 900 } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { custodyLmsClaimRoutes } from "./custody-lms-claim";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PASSWORD = "correct horse battery staple";
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const on: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50 };
const off: CustodyFlags = { ...on, serverSigning: false };
const derived = deriveAllChains(PHRASE, 0).stellar.publicKey;
const imported = Keypair.random();
const expires = () => new Date(Date.now() + 5 * 60_000).toISOString();
const CLAIM_ID = "0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d";
const claim = (destination: string, over: Partial<Record<string, string>> = {}) => [
  over.prefix ?? LMS_CLAIM_PREFIX, `claim:${over.claim ?? CLAIM_ID}`, `destination:${destination}`,
  `amount_stroops:${over.amount ?? "1000000"}`, `expires:${over.expires ?? expires()}`, `nonce:${"a".repeat(64)}`,
].join("\n");
// What the web signLmsClaim does with a key.
const webSign = (kp: Keypair, message: string) => {
  const sig = kp.sign(Buffer.from(new TextEncoder().encode(message))); let bin = ""; for (const b of sig) bin += String.fromCharCode(b); return btoa(bin);
};

const logs: string[] = [];
let pg: PGlite, app: FastifyInstance, offApp: FastifyInstance;
const post = (payload: unknown, a = app) => a.inject({ method: "POST", url: "/api/v1/custody/lms-claim/sign", payload: payload as any });
const sign = (message: string, password = PASSWORD, a = app) => post({ message, password }, a);
const audits = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];
const escrowOpens = async () => (await audits()).filter((a) => a.action === "wallet_key_escrow_open").length;

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4]) await apply(conn);
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  await pg.query("UPDATE users SET password_hash = $1 WHERE id = 1", [await bcrypt.hash(PASSWORD, 4)]);
  const l = (o: unknown, m?: string) => logs.push(JSON.stringify({ o, m }));
  setAppLogger({ info: l, warn: l, error: l });
  app = Fastify(); await app.register(custodyLmsClaimRoutes, { provider, flags: on }); await app.ready();
  offApp = Fastify(); await offApp.register(custodyLmsClaimRoutes, { provider, flags: off }); await offApp.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1; state.frozen = false; logs.length = 0;
  await pg.exec("TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'stellar','testnet',$1,'x',true,0)", [derived]);
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", [await sealForEscrow(provider, PHRASE, { userId: 1, kind: "phrase" })]);
});
afterAll(async () => { await app?.close(); await offApp?.close(); await pg?.close(); });

describe("POST /api/v1/custody/lms-claim/sign", () => {
  it("signs a derived wallet's claim; the signature verifies and equals the web device signature", async () => {
    const message = claim(derived);
    const res = await sign(message);
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(["signature"]);
    const { signature } = res.json();
    expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(Keypair.fromPublicKey(derived).verify(Buffer.from(message, "utf8"), Buffer.from(signature, "base64"))).toBe(true);
    const secret = deriveAllChains(PHRASE, 0).stellar.secret();
    expect(signature).toBe(webSign(Keypair.fromSecret(secret), message));
    expect(res.headers["cache-control"]).toBe("no-store");
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(["wallet_key_escrow_open", "wallet_custody_sign", "custody_lms_claim_signed"]);
    expect(a[2].detail).toEqual({ claimId: CLAIM_ID, destination: derived, amountStroops: "1000000", expires: message.split("\n")[4].slice("expires:".length) });
    expect(a[1].detail).toMatchObject({ reason: "lms-claim-sign" });
  });

  it("signs an imported wallet's claim", async () => {
    const kind = importKind("stellar", imported.publicKey());
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'stellar','testnet',$1,'imp',false)", [imported.publicKey()]);
    await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,$1,$2,'local','import')",
      [kind, await sealForEscrow(provider, imported.secret(), { userId: 1, kind })]);
    const message = claim(imported.publicKey());
    const res = await sign(message);
    expect(res.statusCode).toBe(200);
    expect(res.json().signature).toBe(webSign(imported, message));
  });

  it.each([
    ["arbitrary text", "send all my funds to GABC"],
    ["another prefix", claim(derived, { prefix: "Pay me" })],
    ["an extra line", claim(derived) + "\nextra:1"],
    ["a bad amount", claim(derived, { amount: "0" })],
    ["an empty message", ""],
  ])("refuses %s with 400, opens no escrow and signs nothing", async (_n, message) => {
    const res = await sign(message);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("This is not a valid LMS reward claim.");
    expect(await audits()).toEqual([]);
  });

  it("refuses unknown fields, a missing or oversized message and a missing password", async () => {
    for (const body of [{ message: claim(derived), password: PASSWORD, extra: 1 }, { password: PASSWORD }, { message: "x".repeat(1025), password: PASSWORD }, { message: claim(derived) }, { message: claim(derived), password: "" }, { message: 5, password: PASSWORD }]) {
      expect((await post(body)).statusCode).toBe(400);
    }
    expect(await audits()).toEqual([]);
  });

  it("refuses a wrong password with 403, opens no escrow and leaks nothing", async () => {
    const res = await sign(claim(derived), "nope-wrong");
    expect(res.statusCode).toBe(403);
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(["wallet_custody_sign_denied"]);
    expect(await escrowOpens()).toBe(0);
    expect(JSON.stringify(a) + res.body + logs.join("")).not.toContain("nope-wrong");
    expect(res.body).not.toContain("signature");
  });

  it("refuses a destination that is not this user's wallet and opens no escrow", async () => {
    const res = await sign(claim(Keypair.random().publicKey()));
    expect(res.statusCode).toBe(403);
    expect(await escrowOpens()).toBe(0);
    expect((await audits()).map((x) => x.action)).not.toContain("custody_lms_claim_signed");
  });

  it("refuses another user's wallet", async () => {
    await pg.query("UPDATE user_wallets SET user_id = 2");
    const res = await sign(claim(derived));
    expect(res.statusCode).toBe(403);
    expect(await escrowOpens()).toBe(0);
  });

  it("refuses a wallet that is not on the Stellar test network", async () => {
    await pg.query("UPDATE user_wallets SET network = 'public'");
    expect((await sign(claim(derived))).statusCode).toBe(403);
    expect(await escrowOpens()).toBe(0);
  });

  it("answers 409 for an account that keeps its own keys", async () => {
    await pg.exec("UPDATE users SET signing_mode='self'");
    const res = await sign(claim(derived));
    expect(res.statusCode).toBe(409);
    expect(await escrowOpens()).toBe(0);
  });

  it("answers 423 while a recovery request freezes the account", async () => {
    state.frozen = true;
    const res = await sign(claim(derived));
    expect(res.statusCode).toBe(423);
    expect(await escrowOpens()).toBe(0);
  });

  it("answers 503 when custody signing is off", async () => {
    const res = await sign(claim(derived), PASSWORD, offApp);
    expect(res.statusCode).toBe(503);
    expect(await audits()).toEqual([]);
  });

  it("shares the wrong-password limiter: after 10 wrong tries even the right password gets 429", async () => {
    for (let i = 0; i < 10; i++) expect((await sign(claim(derived), "wrong-" + i)).statusCode).toBe(403);
    expect((await sign(claim(derived))).statusCode).toBe(429);
    expect(await escrowOpens()).toBe(0);
  });

  it("puts no secret in the response, audit rows or logs", async () => {
    const res = await sign(claim(derived));
    const everything = res.body + JSON.stringify(await audits()) + logs.join("");
    for (const secret of [PASSWORD, PHRASE, deriveAllChains(PHRASE, 0).stellar.secret()]) expect(everything).not.toContain(secret);
  });

  it("rate-limits per signed-in user: the 11th correct-password call in a minute gets 429, and another user is counted separately", { timeout: 60_000 }, async () => {
    const { default: rateLimit } = await import("@fastify/rate-limit");
    const { generateAccessToken } = await import("../lib/auth");
    const limited = Fastify();
    await limited.register(rateLimit, { global: false });
    await limited.register(custodyLmsClaimRoutes, { provider, flags: on });
    await limited.ready();
    const as = (id: number) => { state.userId = id; return limited.inject({ method: "POST", url: "/api/v1/custody/lms-claim/sign", headers: { authorization: `Bearer ${generateAccessToken({ userId: id, type: "user" } as any)}` }, payload: { message: claim(derived), password: PASSWORD } }); };
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await as(1)).statusCode);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(codes[10]).toBe(429);
    expect((await as(2)).statusCode).not.toBe(429);
    expect((await as(1)).statusCode).toBe(429);
    await limited.close();
  });
});

describe("lms-claim expiry", () => {
  it("answers 400 claim_expired for an expired claim, before the password check, signing nothing and opening no key", async () => {
    const before = await escrowOpens();
    const res = await sign(claim(derived, { expires: new Date(Date.now() - 1000).toISOString() }), "wrong password");
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "This claim has expired. Start a new claim in the LMS.", code: "claim_expired" });
    expect(await escrowOpens()).toBe(before);
    expect((await audits()).map((a) => a.action)).toEqual([]);
  });
  it("keeps the generic not-valid answer, with no code, for every other bad claim", async () => {
    const res = await sign(claim(derived, { amount: "0" }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "This is not a valid LMS reward claim." });
  });
});

describe("lms-claim network line", () => {
  it("signs a claim whose network line matches this server's network (testnet)", async () => {
    const message = claim(derived) + "\nnetwork:testnet";
    const res = await sign(message);
    expect(res.statusCode).toBe(200);
    expect(Keypair.fromPublicKey(derived).verify(Buffer.from(message, "utf8"), Buffer.from(res.json().signature, "base64"))).toBe(true);
  });
  it("refuses a claim for another network without signing or opening the key", async () => {
    const before = await escrowOpens();
    const res = await sign(claim(derived) + "\nnetwork:mainnet");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("This claim is for a different network than this server.");
    expect(res.json().signature).toBeUndefined();
    expect(await escrowOpens()).toBe(before);
  });
  it("still signs today's 6-line claim", async () => {
    expect((await sign(claim(derived))).statusCode).toBe(200);
  });
});

// The claim's network is compared with the CUSTODY network (networksFor(flags)), not with STELLAR_NETWORK:
// a "public" server with mainnet custody off still does custody on testnet.
describe("lms-claim network line follows the custody network", () => {
  const mainFlags: CustodyFlags = { ...on, mainnet: true, mainnetUserIds: new Set([1]) };
  let mainApp: FastifyInstance;
  beforeAll(async () => { mainApp = Fastify(); await mainApp.register(custodyLmsClaimRoutes, { provider, flags: mainFlags }); await mainApp.ready(); });
  afterAll(async () => { await mainApp?.close(); });

  it("public server, custody off (testnet custody): network:testnet is accepted, network:mainnet refused", async () => {
    expect((await sign(claim(derived) + "\nnetwork:testnet")).statusCode).toBe(200);
    const res = await sign(claim(derived) + "\nnetwork:mainnet");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("This claim is for a different network than this server.");
  });

  it("mainnet custody on: network:testnet is refused before anything is opened", async () => {
    const before = await escrowOpens();
    const res = await sign(claim(derived) + "\nnetwork:testnet", PASSWORD, mainApp);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("This claim is for a different network than this server.");
    expect(await escrowOpens()).toBe(before);
  });

  it("mainnet custody on: network:mainnet passes the network check", async () => {
    await pg.query("UPDATE user_wallets SET network='public' WHERE user_id=1 AND chain='stellar'");
    const res = await sign(claim(derived) + "\nnetwork:mainnet", PASSWORD, mainApp);
    expect(res.statusCode).toBe(200);
  });
});
