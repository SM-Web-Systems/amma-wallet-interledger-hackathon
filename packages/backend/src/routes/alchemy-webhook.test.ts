import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { applyCustodyV3 } from "../db/migrations/custody-v3";
import { applyCustodyV4 } from "../db/migrations/custody-v4";
import { applyCustodyV5 } from "../db/migrations/custody-v5";
import { applyEthAlerts } from "../db/migrations/eth-alerts";
import type { CustodyFlags } from "../lib/custody-flags";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y" } }));

import { alchemyWebhookRoutes, alertTokensFromEnv, DEFAULT_ALERT_TOKENS, signatureValid, WEBHOOK_MAX_BYTES } from "./alchemy-webhook";

const KEY = "whsec_test_signing_key";
const MINE = "0x6b30c7d7657A83141186Cd8c155CDB90C8750371";
const SENDER = "0x1111111111111111111111111111111111111111";
const H = "0x" + "a".repeat(64);
const testnet: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50 };
const mainnet: CustodyFlags = { ...testnet, mainnet: true, mainnetUserIds: new Set([1]) };
const on = { serverData: false, sendSimulate: false, alerts: true };
const sign = (body: string, key = KEY) => createHmac("sha256", key).update(body).digest("hex");
const activity = (o: Record<string, unknown> = {}) => ({ fromAddress: SENDER, toAddress: MINE, blockNum: "0x10", hash: H, value: 0.5, asset: "ETH", category: "external", ...o });
const payload = (acts: unknown[], network = "ETH_SEPOLIA") => JSON.stringify({ webhookId: "wh_1", id: "evt_1", type: "ADDRESS_ACTIVITY", event: { network, activity: acts } });

let pg: PGlite, app: FastifyInstance;
const build = async (o: { key?: string | undefined; flags?: CustodyFlags; eth?: typeof on } = {}) => {
  const a = Fastify();
  await a.register(alchemyWebhookRoutes, { flags: o.flags ?? testnet, eth: o.eth ?? on, signingKey: "key" in o ? o.key : KEY });
  await a.ready();
  return a;
};
const post = (body: string | Buffer, headers: Record<string, string> = {}, a = app) => a.inject({ method: "POST", url: "/api/v1/webhooks/alchemy", headers: { "content-type": "application/json", ...headers }, payload: body });
const signed = (body: string, a = app) => post(body, { "x-alchemy-signature": sign(body) }, a);
const alerts = async () => (await pg.query("SELECT * FROM eth_incoming_alerts ORDER BY id")).rows as any[];

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4, applyCustodyV5, applyEthAlerts]) await apply(conn);
  state.db = drizzle(pg);
  app = await build();
}, 60000);
beforeEach(async () => {
  await pg.exec("DELETE FROM eth_incoming_alerts; DELETE FROM user_wallets");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'evm','sepolia',$1,'e',true,0)", [MINE]);
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (2,'evm','ethereum',$1,'e',true,0)", [MINE]);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("signature check", () => {
  it("accepts only the HMAC-SHA256 hex of the exact raw bytes", () => {
    const raw = Buffer.from('{"a":1}');
    expect(signatureValid(raw, sign('{"a":1}'), KEY)).toBe(true);
    expect(signatureValid(raw, sign('{"a":1}', "other"), KEY)).toBe(false);
    expect(signatureValid(raw, sign('{"a": 1}'), KEY)).toBe(false);
    for (const bad of [undefined, "", "zz", "ab", sign('{"a":1}').slice(1), sign('{"a":1}') + "00", ["x"]]) expect(signatureValid(raw, bad, KEY)).toBe(false);
  });
});

describe("POST /api/v1/webhooks/alchemy", () => {
  it("is 404 without a signing key and without ETH_ALERTS", async () => {
    const body = payload([activity()]);
    expect((await signed(body, await build({ key: undefined }))).statusCode).toBe(404);
    expect((await signed(body, await build({ key: "" }))).statusCode).toBe(404);
    expect((await signed(body, await build({ eth: { ...on, alerts: false } }))).statusCode).toBe(404);
    expect(await alerts()).toHaveLength(0);
  });

  it("rejects a missing, wrong or malformed signature with 401 and stores nothing", async () => {
    const body = payload([activity()]);
    expect((await post(body)).statusCode).toBe(401);
    expect((await post(body, { "x-alchemy-signature": sign(body, "wrong") })).statusCode).toBe(401);
    expect((await post(body, { "x-alchemy-signature": "nothex" })).statusCode).toBe(401);
    expect((await post(body + " ", { "x-alchemy-signature": sign(body) })).statusCode).toBe(401); // body changed after signing
    expect(await alerts()).toHaveLength(0);
  });

  it("rejects a body over 256 KB, signed or not", async () => {
    const big = JSON.stringify({ type: "ADDRESS_ACTIVITY", pad: "x".repeat(WEBHOOK_MAX_BYTES) });
    const res = await post(big, { "x-alchemy-signature": sign(big) });
    expect(res.statusCode).toBe(413);
    expect(await alerts()).toHaveLength(0);
  });

  it("stores an alert for the wallet's owner on this network only, from the raw signed body", async () => {
    const res = await signed(payload([activity()]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, stored: 1 });
    const rows = await alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 1, network: "sepolia", to_address: MINE.toLowerCase(), from_address: SENDER, tx_hash: H, asset: "ETH", value: "0.5", seen_at: null });
  });

  it("stores the exact amount from rawContract.rawValue and decimals, not the float value", async () => {
    // 0.100000000000000001 ETH: the JSON number is 0.1, the hex rawValue is exact.
    const res = await signed(payload([activity({ value: 0.1, rawContract: { rawValue: "0x16345785d8a0001", address: null, decimals: 18 } })]));
    expect(res.json().stored).toBe(1);
    expect((await alerts())[0]).toMatchObject({ asset: "ETH", value: "0.100000000000000001" });
  });

  it("stores a null asset on a native transfer as ETH", async () => {
    expect((await signed(payload([activity({ asset: null, value: 0.001, rawContract: { rawValue: "0x38d7ea4c68000", decimals: 18 } })]))).json().stored).toBe(1);
    expect((await alerts())[0]).toMatchObject({ asset: "ETH", value: "0.001" });
  });

  it("stores one alert for a native transfer, not a second one for its pseudo token log", async () => {
    const pseudo = activity({ category: "token", asset: null, value: 0.001, rawContract: { rawValue: "0x38d7ea4c68000", address: "0xfffffffffffffffffffffffffffffffffffffffe", decimals: 18 }, log: { logIndex: "0x147" } });
    const real = activity({ value: 0.001, rawContract: { rawValue: "0x38d7ea4c68000", address: null, decimals: 18 } });
    const res = await signed(payload([pseudo, real]));
    expect(res.json().stored).toBe(1);
    expect(await alerts()).toHaveLength(1);
  });

  it("ignores other users' addresses, other networks, zero values and non-activity events", async () => {
    const stranger = "0x" + "9".repeat(40);
    expect((await signed(payload([activity({ toAddress: stranger })]))).json().stored).toBe(0);
    expect((await signed(payload([activity()], "ETH_MAINNET"))).json().stored).toBe(0);
    expect((await signed(payload([activity({ value: 0 }), activity({ hash: "0x12" }), activity({ toAddress: "nope" })]))).json().stored).toBe(0);
    const other = JSON.stringify({ type: "MINED_TRANSACTION", event: {} });
    expect((await signed(other)).json().stored).toBe(0);
    expect(await alerts()).toHaveLength(0);
  });

  it("dedupes a re-delivered event but keeps distinct log indexes in the same transaction", async () => {
    const body = payload([activity()]);
    expect((await signed(body)).json().stored).toBe(1);
    expect((await signed(body)).json().stored).toBe(0);
    const token = (i: string) => activity({ category: "external", asset: "ETH", value: 12, log: { logIndex: i } });
    expect((await signed(payload([token("0x1"), token("0x2"), token("0x1")]))).json().stored).toBe(2);
    expect(await alerts()).toHaveLength(3);
  });

  it("matches on mainnet using the ethereum network wallets", async () => {
    const m = await build({ flags: mainnet });
    expect((await signed(payload([activity()], "ETH_MAINNET"), m)).json().stored).toBe(1);
    const rows = await alerts();
    expect(rows[0]).toMatchObject({ user_id: 2, network: "ethereum" });
    expect((await signed(payload([activity()], "ETH_SEPOLIA"), m)).json().stored).toBe(0);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    expect((await signed("not json")).statusCode).toBe(400);
  });
});

describe("address poisoning: only ETH and allow-listed tokens raise alerts", () => {
  const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  const token = (addr: string, i: string) => activity({ category: "token", asset: "USDC", value: 12, rawContract: { address: addr }, log: { logIndex: i } });

  it("the defaults are valid 20-byte hex addresses: USDC and USDT on mainnet, nothing on Sepolia", () => {
    for (const a of DEFAULT_ALERT_TOKENS.ethereum) expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    expect(DEFAULT_ALERT_TOKENS.ethereum).toEqual([USDC, USDT]);
    expect(DEFAULT_ALERT_TOKENS.sepolia).toEqual([]);
    expect([...alertTokensFromEnv({}, "ethereum")]).toEqual([USDC, USDT]);
    expect([...alertTokensFromEnv({}, "sepolia")]).toEqual([]);
  });
  it("ETH_ALERT_TOKENS replaces the defaults, lowercases, and drops malformed entries", () => {
    const set = alertTokensFromEnv({ ETH_ALERT_TOKENS: ` ${USDC.toUpperCase().replace("0X", "0x")}, nope, 0x123 ` }, "ethereum");
    expect([...set]).toEqual([USDC]);
    expect(alertTokensFromEnv({ ETH_ALERT_TOKENS: "" }, "ethereum").size).toBe(0);
  });
  it("stores native ETH and an allow-listed token, ignores unknown tokens, NFTs and other categories", async () => {
    const m = await build({ flags: mainnet });
    const body = payload([
      activity({ category: "internal", log: undefined }),
      token(USDC, "0x1"),
      token("0x" + "7".repeat(40), "0x2"),            // unlisted token (poisoning dust)
      activity({ category: "erc721", asset: "NFT", log: { logIndex: "0x3" } }),
      activity({ category: "token", asset: "FAKE", value: 5, log: { logIndex: "0x4" } }), // no contract at all
    ], "ETH_MAINNET");
    expect((await signed(body, m)).json().stored).toBe(2);
    expect((await alerts()).map((r) => r.asset).sort()).toEqual(["ETH", "USDC"]);
  });
  it("a testnet server with no allow-list ignores every token", async () => {
    expect((await signed(payload([token(USDC, "0x1"), activity()]))).json().stored).toBe(1);
  });
});
