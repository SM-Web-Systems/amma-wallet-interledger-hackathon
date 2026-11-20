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
import { applyCustodyV5 } from "../db/migrations/custody-v5";
import { applyEthAlerts } from "../db/migrations/eth-alerts";
import { setAppLogger } from "../lib/app-log";
import { CUSTODY_NOT_AVAILABLE, type CustodyFlags } from "../lib/custody-flags";
import type { EthDataFlags, FetchLike } from "../lib/alchemy";
import { approvalLog, erc20Log, nativeLog, okCall, revertedCall, simResult } from "../lib/eth-simulate.fixtures";

const state = vi.hoisted(() => ({ db: undefined as any, userId: 1, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y" } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { custodyEvmDataRoutes } from "./custody-evm-data";

const SECRET_URL = "https://eth-mainnet.g.alchemy.com/v2/SECRETKEY123";
const MINE = "0x6b30c7d7657A83141186Cd8c155CDB90C8750371";
const OTHER = "0x2222222222222222222222222222222222222222";
const DEST = "0x1111111111111111111111111111111111111111";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const H1 = "0x" + "1".repeat(64), H2 = "0x" + "2".repeat(64), H3 = "0x" + "3".repeat(64);
const testnet: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50 };
const mainnet: CustodyFlags = { ...testnet, mainnet: true, mainnetUserIds: new Set([1]) };
const allOn: EthDataFlags = { serverData: true, sendSimulate: false, alerts: true };

type Handler = (params: any[]) => unknown;
let handlers: Record<string, Handler>;
const calls: { url: string; method: string; params: any[] }[] = [];
const fetchMock: FetchLike = async (url, init) => {
  const req = JSON.parse(init.body);
  calls.push({ url, method: req.method, params: req.params });
  const h = handlers[req.method];
  if (!h) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope " + url } }) };
  try { return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: h(req.params) }) }; }
  catch (e) { throw new Error(`connect failed to ${url}: ${(e as Error).message}`); }
};
const count = (m: string) => calls.filter((c) => c.method === m).length;

let pg: PGlite;
const logs: string[] = [];
let clock = 1_000_000;
const build = async (o: { flags?: CustodyFlags; eth?: EthDataFlags; url?: string | null } = {}) => {
  const a = Fastify();
  await a.register(custodyEvmDataRoutes, { flags: o.flags ?? testnet, eth: o.eth ?? allOn, rpcUrl: () => (o.url === undefined ? SECRET_URL : o.url), fetch: fetchMock, now: () => clock });
  await a.ready();
  return a;
};
let app: FastifyInstance;
const get = (url: string, a = app) => a.inject({ method: "GET", url });

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4, applyCustodyV5, applyEthAlerts]) await apply(conn);
  state.db = drizzle(pg);
  setAppLogger({ info: (o, m) => logs.push(JSON.stringify({ o, m })), warn: (o, m) => logs.push(JSON.stringify({ o, m })), error: (o, m) => logs.push(JSON.stringify({ o, m })) });
}, 60000);
beforeEach(async () => {
  state.userId = 1; state.frozen = false; calls.length = 0; logs.length = 0; clock += 10 * 60_000;
  handlers = {};
  await pg.exec("DELETE FROM eth_incoming_alerts; DELETE FROM user_wallets");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'evm','sepolia',$1,'e',true,0)", [MINE]);
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'evm','ethereum',$1,'e',true,0)", [MINE]);
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (2,'evm','sepolia',$1,'e',true,0)", [OTHER]);
  app = await build();
});
afterAll(async () => { await pg?.close(); });
const noSecretAnywhere = (...parts: unknown[]) => { for (const p of [...parts, logs]) expect(JSON.stringify(p)).not.toContain("SECRETKEY123"); };

describe("config and flag", () => {
  it("reports the flags, and everything else is 404 while ETH_SERVER_DATA is off", async () => {
    const off = await build({ eth: { serverData: false, sendSimulate: false, alerts: false } });
    expect((await get("/api/v1/custody/evm/config", off)).json()).toEqual({ serverData: false, simulate: false, alerts: false, network: "sepolia" });
    expect((await get(`/api/v1/custody/evm/balances?address=${MINE}`, off)).statusCode).toBe(404);
    expect((await get(`/api/v1/custody/evm/history?address=${MINE}`, off)).statusCode).toBe(404);
    expect((await off.inject({ method: "POST", url: "/api/v1/custody/evm/preview", payload: { from: MINE, to: DEST, amountWei: "1" } })).statusCode).toBe(404);
    expect((await get("/api/v1/custody/evm/alerts", off)).statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it("is on for an allowed user and off for a user outside the mainnet allowlist", async () => {
    const m = await build({ flags: mainnet });
    expect((await get("/api/v1/custody/evm/config", m)).json()).toMatchObject({ serverData: true, network: "ethereum" });
    state.userId = 5;
    expect((await get("/api/v1/custody/evm/config", m)).json()).toMatchObject({ serverData: false, alerts: false });
  });
});

describe("GET /api/v1/custody/evm/balances", () => {
  beforeEach(() => {
    handlers.eth_getBalance = () => "0xde0b6b3a7640000"; // 1 ETH
    handlers.alchemy_getTokenBalances = () => ({ tokenBalances: [
      { contractAddress: USDC, tokenBalance: "0x" + (2_500_000).toString(16) },
      { contractAddress: "0x" + "d".repeat(40), tokenBalance: "0x0000000000000000000000000000000000000000000000000000000000000000" },
      { contractAddress: "0x" + "e".repeat(40), tokenBalance: null, error: "x" },
    ] });
    handlers.alchemy_getTokenMetadata = ([c]) => ({ symbol: "USDC", name: "USD Coin", decimals: 6, logo: c === USDC ? "https://static.alchemyapi.io/usdc.png" : null });
  });

  it("returns ETH and non-zero tokens with metadata, hiding zero and errored balances", async () => {
    const res = await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ address: MINE.toLowerCase(), network: "sepolia", wei: "1000000000000000000", tokensUnavailable: false,
      tokens: [{ contract: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, logo: "https://static.alchemyapi.io/usdc.png", balance: "2500000" }] });
    expect(calls.map((c) => c.method).sort()).toEqual(["alchemy_getTokenBalances", "alchemy_getTokenMetadata", "eth_getBalance"]);
    expect(calls.find((c) => c.method === "alchemy_getTokenBalances")!.params).toEqual([MINE.toLowerCase(), "erc20"]);
    noSecretAnywhere(res.body);
  });

  it("caches per address for 30 seconds", async () => {
    await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    await get(`/api/v1/custody/evm/balances?address=${MINE.toLowerCase()}`);
    expect(count("eth_getBalance")).toBe(1);
    clock += 29_000; await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(count("eth_getBalance")).toBe(1);
    clock += 2_000; await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(count("eth_getBalance")).toBe(2);
    expect(count("alchemy_getTokenMetadata")).toBe(1); // metadata is cached much longer
  });

  it("still shows ETH when the token call fails, and does not cache that partial answer", async () => {
    handlers.alchemy_getTokenBalances = () => { throw new Error("boom"); };
    const res = await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(res.json()).toMatchObject({ wei: "1000000000000000000", tokens: [], tokensUnavailable: true });
    await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(count("eth_getBalance")).toBe(2);
    noSecretAnywhere(res.body);
  });

  it("answers a plain 503 without the URL when the balance call fails", async () => {
    handlers.eth_getBalance = () => { throw new Error("boom"); };
    const res = await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/not available right now/);
    noSecretAnywhere(res.body);
    expect(logs.join("")).toContain("network");
  });

  it("refuses an address that is not the user's, another user's, a bad one, and a wallet on the other network", async () => {
    expect((await get(`/api/v1/custody/evm/balances?address=${OTHER}`)).statusCode).toBe(403);
    expect((await get(`/api/v1/custody/evm/balances?address=${DEST}`)).statusCode).toBe(403);
    expect((await get(`/api/v1/custody/evm/balances?address=0x123`)).statusCode).toBe(400);
    expect((await get(`/api/v1/custody/evm/balances`)).statusCode).toBe(400);
    await pg.exec("DELETE FROM user_wallets WHERE network = 'sepolia'"); // only the mainnet row is left; this server is on Sepolia
    expect((await get(`/api/v1/custody/evm/balances?address=${MINE}`)).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("refuses a user outside the mainnet allowlist before anything else, and works on the mainnet network for a listed user", async () => {
    const m = await build({ flags: mainnet });
    state.userId = 2;
    const res = await get(`/api/v1/custody/evm/balances?address=${OTHER}`, m);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(CUSTODY_NOT_AVAILABLE);
    expect(calls).toHaveLength(0);
    state.userId = 1;
    expect((await get(`/api/v1/custody/evm/balances?address=${MINE}`, m)).json().network).toBe("ethereum");
  });

  it("is 503 when no RPC is configured", async () => {
    const none = await build({ url: null });
    expect((await get(`/api/v1/custody/evm/balances?address=${MINE}`, none)).statusCode).toBe(503);
  });
});

describe("GET /api/v1/custody/evm/history", () => {
  const t = (o: Record<string, unknown>) => ({ category: "external", asset: "ETH", value: 0.5, ...o });
  beforeEach(() => {
    handlers.alchemy_getAssetTransfers = ([p]) => p.fromAddress
      ? { transfers: [t({ hash: H1, from: MINE, to: DEST, blockNum: "0x10", uniqueId: "a:external", metadata: { blockTimestamp: "2026-11-10T10:00:00.000Z" } })], pageKey: "out-next" }
      : { transfers: [
        t({ hash: H2, from: DEST, to: MINE, blockNum: "0x20", uniqueId: "b:external", value: 1.25, metadata: { blockTimestamp: "2026-11-11T10:00:00.000Z" } }),
        t({ hash: H3, from: DEST, to: MINE, blockNum: "0x05", uniqueId: "c:log:0", category: "erc20", asset: "USDC", value: 12, metadata: { blockTimestamp: "2026-11-09T10:00:00.000Z" } }),
      ] };
  });

  it("maps a real Alchemy ETH record (numeric value, hex rawContract) to asset ETH and an exact decimal string", async () => {
    const real = { blockNum: "0xb92f29", uniqueId: H1 + ":external", hash: H1, from: MINE.toLowerCase(), to: DEST, value: 0.001, erc721TokenId: null, erc1155Metadata: null, tokenId: null, asset: "ETH", category: "external",
      rawContract: { value: "0x38d7ea4c68000", address: null, decimal: "0x12" }, metadata: { blockTimestamp: "2026-11-15T10:00:00.000Z" } };
    handlers.alchemy_getAssetTransfers = ([p]) => ({ transfers: p.fromAddress ? [real] : [] });
    const body = (await get(`/api/v1/custody/evm/history?address=${MINE}`)).json();
    expect(body.transfers).toEqual([{ hash: H1, direction: "out", asset: "ETH", value: "0.001", counterparty: DEST, timestamp: "2026-11-15T10:00:00.000Z" }]);
  });

  it("uses ETH for external and internal even when asset is null, and the symbol and exact raw amount for erc20", async () => {
    const tok = { blockNum: "0x30", uniqueId: H3 + ":log:1", hash: H3, from: DEST, to: MINE.toLowerCase(), value: 12.345678, asset: "USDC", category: "erc20", rawContract: { value: "0xbc614e", address: USDC, decimal: "0x6" }, metadata: { blockTimestamp: "2026-11-09T10:00:00.000Z" } };
    const internalNull = { blockNum: "0x20", uniqueId: H2 + ":internal:0", hash: H2, from: DEST, to: MINE.toLowerCase(), value: 1, asset: null, category: "internal", rawContract: { value: "0xde0b6b3a7640000", address: null, decimal: "0x12" } };
    handlers.alchemy_getAssetTransfers = ([p]) => ({ transfers: p.fromAddress ? [] : [tok, internalNull] });
    const body = (await get(`/api/v1/custody/evm/history?address=${MINE}`)).json();
    expect(body.transfers.map((x: any) => [x.asset, x.value])).toEqual([["USDC", "12.345678"], ["ETH", "1"]]);
  });

  it("drops the pseudo erc20 log Alchemy adds for every native ETH transfer, and any erc20 with no contract and no asset", async () => {
    const hash = "0x919dc6cd27617564f05bc7f1b2f81dd16e85b7a2ccb57a32fbc6ef22f601dd4a";
    const ext = { blockNum: "0xb92f29", uniqueId: hash + ":external", hash, from: MINE.toLowerCase(), to: DEST, value: 0.001, asset: "ETH", category: "external", rawContract: { value: "0x38d7ea4c68000", address: null, decimal: "0x12" }, metadata: { blockTimestamp: "2026-11-15T10:00:00.000Z" } };
    const sys = { blockNum: "0xb92f29", uniqueId: hash + ":log:327", hash, from: MINE.toLowerCase(), to: DEST, value: null, asset: null, category: "erc20", rawContract: { value: "0x38d7ea4c68000", address: "0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfE", decimal: null }, metadata: { blockTimestamp: "2026-11-15T10:00:00.000Z" } };
    const bare = { ...sys, uniqueId: hash + ":log:9", rawContract: { value: "0x1", address: null, decimal: null } };
    handlers.alchemy_getAssetTransfers = ([p]) => ({ transfers: p.fromAddress ? [sys, ext, bare] : [] });
    const body = (await get(`/api/v1/custody/evm/history?address=${MINE}`)).json();
    expect(body.transfers).toEqual([{ hash, direction: "out", asset: "ETH", value: "0.001", counterparty: DEST, timestamp: "2026-11-15T10:00:00.000Z" }]);
  });

  it("falls back to the numeric value only when rawContract is missing", async () => {
    handlers.alchemy_getAssetTransfers = ([p]) => ({ transfers: p.fromAddress ? [t({ hash: H1, from: MINE, to: DEST, blockNum: "0x10", value: 0.25 })] : [] });
    expect((await get(`/api/v1/custody/evm/history?address=${MINE}`)).json().transfers[0]).toMatchObject({ asset: "ETH", value: "0.25" });
  });

  it("merges outgoing and incoming, newest block first, in the compact shape", async () => {
    const res = await get(`/api/v1/custody/evm/history?address=${MINE}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transfers).toEqual([
      { hash: H2, direction: "in", asset: "ETH", value: "1.25", counterparty: DEST, timestamp: "2026-11-11T10:00:00.000Z" },
      { hash: H1, direction: "out", asset: "ETH", value: "0.5", counterparty: DEST, timestamp: "2026-11-10T10:00:00.000Z" },
      { hash: H3, direction: "in", asset: "USDC", value: "12", counterparty: DEST, timestamp: "2026-11-09T10:00:00.000Z" },
    ]);
    const asked = calls.filter((c) => c.method === "alchemy_getAssetTransfers").map((c) => c.params[0]);
    expect(asked).toHaveLength(2);
    for (const p of asked) expect(p).toMatchObject({ category: ["external", "erc20"], withMetadata: true, maxCount: "0x19", order: "desc" });
    expect(asked.map((p) => Boolean(p.fromAddress)).sort()).toEqual([false, true]);
    expect(body.pageKey).toEqual(expect.any(String));
    noSecretAnywhere(res.body);
  });

  it("continues only the direction that has a next page, using the page key it gave out", async () => {
    const first = (await get(`/api/v1/custody/evm/history?address=${MINE}`)).json();
    calls.length = 0;
    const second = await get(`/api/v1/custody/evm/history?address=${MINE}&pageKey=${first.pageKey}`);
    expect(second.statusCode).toBe(200);
    const asked = calls.filter((c) => c.method === "alchemy_getAssetTransfers").map((c) => c.params[0]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ fromAddress: MINE.toLowerCase(), pageKey: "out-next" });
  });

  it("rejects a forged page key and a foreign address", async () => {
    expect((await get(`/api/v1/custody/evm/history?address=${MINE}&pageKey=!!!`)).statusCode).toBe(400);
    const evil = Buffer.from(JSON.stringify({ o: "x\"; drop" })).toString("base64url");
    expect((await get(`/api/v1/custody/evm/history?address=${MINE}&pageKey=${evil}`)).statusCode).toBe(400);
    expect((await get(`/api/v1/custody/evm/history?address=${OTHER}`)).statusCode).toBe(403);
  });
  it("applies the mainnet allowlist", async () => {
    const m = await build({ flags: mainnet });
    state.userId = 2;
    expect((await get(`/api/v1/custody/evm/history?address=${OTHER}`, m)).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/v1/custody/evm/preview", () => {
  const post = (payload: unknown, a = app) => a.inject({ method: "POST", url: "/api/v1/custody/evm/preview", payload: payload as any });
  const ok = { from: MINE, to: DEST, amountWei: "500000000000000000" };
  const eth = (wei = 500000000000000000n) => nativeLog(MINE, DEST, wei);
  beforeEach(() => { handlers.eth_gasPrice = () => "0x77359400"; /* 2 gwei */ });

  it("shows the expected ETH out, a gas estimate and no warnings", async () => {
    handlers.eth_simulateV1 = () => simResult(okCall([eth()]));
    const res = await post(ok);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changes: [{ asset: "ETH", direction: "out", amount: "0.5" }], gasEstimateWei: String(21000n * 2_000_000_000n), warnings: [] });
    const sent = calls.find((c) => c.method === "eth_simulateV1")!.params;
    expect(sent).toEqual([{ blockStateCalls: [{ blockOverrides: { baseFeePerGas: "0x3b9aca00" }, calls: [{ from: MINE.toLowerCase(), to: DEST, value: "0x6f05b59d3b20000", gas: "0x5208", maxFeePerGas: "0x77359400", maxPriorityFeePerGas: "0x3b9aca00" }] }], traceTransfers: true }, "latest"]);
    noSecretAnywhere(res.body);
  });

  it("simulates with the estimated gas limit (bounded, 21000 when the estimate fails or is absurd)", async () => {
    handlers.eth_simulateV1 = () => simResult(okCall([eth()]));
    const gasOf = () => calls.filter((c) => c.method === "eth_simulateV1").pop()!.params[0].blockStateCalls[0].calls[0].gas;
    handlers.eth_estimateGas = () => "0xc350"; // 50000
    await post(ok);
    expect(gasOf()).toBe("0xc350");
    expect(calls.find((c) => c.method === "eth_estimateGas")!.params[0]).toEqual({ from: MINE.toLowerCase(), to: DEST, value: "0x6f05b59d3b20000" });
    handlers.eth_estimateGas = () => "0x1c9c380"; // 30M: not bounded
    await post(ok);
    expect(gasOf()).toBe("0x5208");
    handlers.eth_estimateGas = () => { throw new Error("boom"); };
    await post(ok);
    expect(gasOf()).toBe("0x5208");
  });

  it("answers -38014 insufficient funds with a clear warning", async () => {
    handlers.eth_simulateV1 = () => { throw Object.assign(new Error("x"), { rpc: -38014 }); };
    const f: FetchLike = async (_u, init) => {
      const m = JSON.parse(init.body).method;
      if (m === "eth_simulateV1") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -38014, message: "insufficient funds for gas * price + value: have 0.009 ETH want 0.401 ETH" } }) };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x5208" }) };
    };
    const a = Fastify();
    await a.register(custodyEvmDataRoutes, { flags: testnet, eth: allOn, rpcUrl: () => SECRET_URL, fetch: f, now: () => clock });
    await a.ready();
    const res = await post(ok, a);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ changes: [], gasEstimateWei: null, warnings: ["This wallet doesn't hold enough ETH for this amount plus the network fee."] });
    noSecretAnywhere(res.body);
  });

  it("warns about any other change: a token leaving, an approval, an incoming token, a different amount", async () => {
    const THEM = "0x3333333333333333333333333333333333333333";
    handlers.eth_simulateV1 = () => simResult(okCall([eth(), erc20Log(USDC, MINE, DEST, 5n), approvalLog(USDC, MINE, THEM, 9n), erc20Log(USDC, DEST, MINE, 3n)]));
    const w = (await post(ok)).json().warnings as string[];
    expect(w).toHaveLength(3);
    expect(w[0]).toContain("5 token 0xa0b86991 out of your wallet");
    expect(w[1]).toContain("spend your token 0xa0b86991");
    expect(w[2]).toContain("3 token 0xa0b86991 into your wallet");
    handlers.eth_simulateV1 = () => simResult(okCall([eth(600000000000000000n)]));
    expect((await post(ok)).json().warnings[0]).toContain("0.6 ETH out of your wallet");
  });

  it("warns when the simulation reports an error or the check cannot run", async () => {
    handlers.eth_simulateV1 = () => simResult(revertedCall("execution reverted"));
    expect((await post(ok)).json().warnings[0]).toContain("execution reverted");
    handlers.eth_simulateV1 = () => { throw new Error("boom"); };
    const res = await post(ok);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changes: [], gasEstimateWei: null });
    expect(res.json().warnings[0]).toMatch(/couldn't check/);
    const failed = logs.map((l) => JSON.parse(l)).filter((l) => l.m === "eth_preview_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].o).toEqual({ reason: "network" });
    expect(failed[0].o).not.toHaveProperty("code");
  });

  it("maps Alchemy's -32600 Unsupported method to the distinct reason rpc_unsupported and the same friendly warning", async () => {
    handlers.eth_simulateV1 = () => { throw Object.assign(new Error("x"), { rpc: -32600 }); };
    const f: FetchLike = async (_u, init) => {
      const m = JSON.parse(init.body).method;
      if (m === "eth_simulateV1") return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Unsupported method" } }) };
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x1" }) };
    };
    const a = Fastify();
    await a.register(custodyEvmDataRoutes, { flags: testnet, eth: allOn, rpcUrl: () => SECRET_URL, fetch: f, now: () => clock });
    await a.ready();
    const res = await post(ok, a);
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings[0]).toMatch(/couldn't check/);
    expect(logs.map((l) => JSON.parse(l)).find((l) => l.m === "eth_preview_failed").o).toEqual({ reason: "rpc_unsupported" });
    noSecretAnywhere(res.body);
    noSecretAnywhere(res.body);
  });

  it("validates the body, ownership, allowlist and freeze", async () => {
    expect((await post({ ...ok, extra: 1 })).statusCode).toBe(400);
    expect((await post({ ...ok, amountWei: "0" })).statusCode).toBe(400);
    expect((await post({ ...ok, amountWei: "1.5" })).statusCode).toBe(400);
    expect((await post({ ...ok, to: MINE })).statusCode).toBe(400);
    expect((await post({ ...ok, from: OTHER })).statusCode).toBe(403);
    state.frozen = true;
    expect((await post(ok)).statusCode).toBe(423);
    state.frozen = false;
    const m = await build({ flags: mainnet });
    state.userId = 2;
    expect((await post({ ...ok, from: OTHER }, m)).json().error).toBe(CUSTODY_NOT_AVAILABLE);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /api/v1/custody/evm/alerts", () => {
  const ins = (user: number, key: string, net = "sepolia") => pg.query(
    "INSERT INTO eth_incoming_alerts (user_id, network, to_address, from_address, tx_hash, event_key, asset, value) VALUES ($1,$2,$3,$4,$5,$6,'ETH','0.5')", [user, net, MINE.toLowerCase(), DEST, H1, key]);
  const post = (ids: unknown, a = app) => a.inject({ method: "POST", url: "/api/v1/custody/evm/alerts/seen", payload: { ids } as any });
  it("returns this user's unread alerts oldest first, and reading alone does not mark them seen", async () => {
    await ins(1, "external:0"); await ins(1, "external:1"); await ins(2, "external:2"); await ins(1, "external:3", "ethereum");
    const first = (await get("/api/v1/custody/evm/alerts")).json().alerts;
    expect(first.map((a: any) => a.asset)).toEqual(["ETH", "ETH"]);
    expect(first[0]).toMatchObject({ hash: H1, to: MINE.toLowerCase(), from: DEST, value: "0.5" });
    expect((await get("/api/v1/custody/evm/alerts")).json().alerts).toHaveLength(2); // a client that failed to store them gets them again
  });
  it("POST /alerts/seen marks only this user's own, unseen, listed alerts", async () => {
    await ins(1, "external:0"); await ins(1, "external:1"); await ins(2, "external:2");
    const mine = (await get("/api/v1/custody/evm/alerts")).json().alerts as { id: string }[];
    const foreign = ((await pg.query("SELECT id FROM eth_incoming_alerts WHERE user_id = 2")).rows[0] as any).id;
    const res = await post([mine[0].id, String(foreign)]);
    expect(res.json()).toEqual({ marked: 1 });
    expect((await get("/api/v1/custody/evm/alerts")).json().alerts.map((a: any) => a.id)).toEqual([mine[1].id]);
    expect((await pg.query("SELECT seen_at FROM eth_incoming_alerts WHERE user_id = 2")).rows[0]).toEqual({ seen_at: null });
    expect((await post([mine[0].id])).json()).toEqual({ marked: 0 });
    for (const bad of [[], "1", ["x"], ["1; drop"], Array.from({ length: 51 }, (_, i) => String(i + 1))]) expect((await post(bad)).statusCode).toBe(400);
  });
  it("POST /alerts/seen is 404 when alerts are off and follows the allowlist", async () => {
    const off = await build({ eth: { ...allOn, alerts: false } });
    expect((await post(["1"], off)).statusCode).toBe(404);
    const m = await build({ flags: mainnet });
    state.userId = 2;
    expect((await post(["1"], m)).statusCode).toBe(403);
  });
  it("is 404 unless ETH_ALERTS is on, and follows the allowlist", async () => {
    const off = await build({ eth: { ...allOn, alerts: false } });
    expect((await get("/api/v1/custody/evm/alerts", off)).statusCode).toBe(404);
    const m = await build({ flags: mainnet });
    state.userId = 2;
    expect((await get("/api/v1/custody/evm/alerts", m)).statusCode).toBe(403);
  });
});

describe("freeze, metadata cache and parallelism", () => {
  it("balances and history refuse while a recovery freezes the account, before any RPC", async () => {
    state.frozen = true;
    expect((await get(`/api/v1/custody/evm/balances?address=${MINE}`)).statusCode).toBe(423);
    expect((await get(`/api/v1/custody/evm/history?address=${MINE}`)).statusCode).toBe(423);
    expect(calls).toHaveLength(0);
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ contractAddress: "0x" + (i + 1).toString(16).padStart(40, "0"), tokenBalance: "0x1" }));
  it("asks for token metadata at most 5 at a time", async () => {
    handlers.eth_getBalance = () => "0x1";
    handlers.alchemy_getTokenBalances = () => ({ tokenBalances: many(12) });
    let live = 0, peak = 0;
    const slow: FetchLike = async (url, init) => {
      const r = JSON.parse(init.body);
      if (r.method === "alchemy_getTokenMetadata") { live++; peak = Math.max(peak, live); await new Promise((x) => setTimeout(x, 5)); live--; }
      return fetchMock(url, init);
    };
    handlers.alchemy_getTokenMetadata = () => ({ symbol: "T", name: "T", decimals: 18, logo: null });
    const a = Fastify();
    await a.register(custodyEvmDataRoutes, { flags: testnet, eth: allOn, rpcUrl: () => SECRET_URL, fetch: slow, now: () => clock });
    await a.ready();
    const res = await get(`/api/v1/custody/evm/balances?address=${MINE}`, a);
    expect(res.json().tokens).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });

  it("remembers a failed metadata lookup for 10 minutes instead of asking on every refresh", async () => {
    handlers.eth_getBalance = () => "0x1";
    handlers.alchemy_getTokenBalances = () => ({ tokenBalances: many(1) });
    handlers.alchemy_getTokenMetadata = () => { throw new Error("boom"); };
    const first = await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(first.json().tokens[0]).toMatchObject({ symbol: null, decimals: null });
    clock += 60_000; // past the 30s balance cache, inside the 10 minute failure memory
    await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(count("alchemy_getTokenMetadata")).toBe(1);
    clock += 10 * 60_000;
    await get(`/api/v1/custody/evm/balances?address=${MINE}`);
    expect(count("alchemy_getTokenMetadata")).toBe(2);
  });
});
