import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { applyCustodyV3 } from "../db/migrations/custody-v3";
import { LocalMasterKeyProvider, sealForEscrow } from "../lib/key-wrapper";
import { custodyLimitsFromEnv, type CustodyLimits } from "../lib/custody-limits";
import { setAppLogger } from "../lib/app-log";
import { deriveAllChains } from "../lib/one-phrase";
import type { CustodyFlags } from "../lib/custody-flags";
import { SEND_MOVES_MORE } from "../lib/eth-simulate";
import { erc20Log, nativeLog, okCall, revertedCall, simResult } from "../lib/eth-simulate.fixtures";

const state = vi.hoisted(() => ({ db: undefined as any, userId: 1, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y" } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { custodyEvmSendRoutes, type EvmClient } from "./custody-evm-send";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PASSWORD = "correct horse battery staple";
const EVM = "0x6b30c7d7657A83141186Cd8c155CDB90C8750371";
const DEST = "0x1111111111111111111111111111111111111111";
const DEST2 = "0x2222222222222222222222222222222222222222";
const ZERO = "0x0000000000000000000000000000000000000000";
const FINNEY = 10n ** 15n;
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const on: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50 };
let n = 0;
const key = () => `idem-key-${++n}-${Date.now()}`;
const client = {
  getChainId: vi.fn(async () => 11155111),
  getBalance: vi.fn(async (_a: string) => 10n ** 18n),
  getTransactionCount: vi.fn(async (_a: string) => 3),
  estimateGas: vi.fn(async (_a: any) => 21000n),
  estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })),
  sendRawTransaction: vi.fn(async (raw: `0x${string}`) => keccak256(raw)),
  getTransactionReceipt: vi.fn(async (_h: string): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null> => null),
  getBlockNumber: vi.fn(async () => 1000n),
} satisfies EvmClient;
const logs: string[] = [];
let pg: PGlite, app: FastifyInstance, limits: CustodyLimits, rpc: string | undefined;
let evmKey = "";
const send = (over: Record<string, unknown> = {}, a = app) => a.inject({
  method: "POST", url: "/api/v1/custody/evm/send",
  payload: { from: EVM, to: DEST, amountWei: String(5n * FINNEY), password: PASSWORD, idempotencyKey: key(), ...over },
});
const list = (from = EVM) => app.inject({ method: "GET", url: `/api/v1/custody/evm/transfers?from=${from}` });
const rowsOf = async () => (await pg.query("SELECT * FROM custody_evm_transfers ORDER BY id")).rows as any[];
const audits = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];
let seedN = 0;
const seed = async (o: { value: bigint; to?: string; state?: string; ageHours?: number; user?: number; nonce?: number }) => {
  seedN++;
  await pg.query(`INSERT INTO custody_evm_transfers(user_id,from_address,to_address,value_wei,nonce,hash,state,idempotency_key,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - ($9 || ' hours')::interval)`,
  [o.user ?? 1, EVM.toLowerCase(), o.to ?? DEST2, o.value.toString(), o.nonce ?? seedN, "0x" + seedN.toString(16).padStart(64, "0"), o.state ?? "confirmed", `seed-key-${seedN}`, String(o.ageHours ?? 1)]);
};

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3]) await apply(conn);
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  await pg.query("UPDATE users SET password_hash = $1 WHERE id IN (1,2)", [await bcrypt.hash(PASSWORD, 4)]);
  evmKey = deriveAllChains(PHRASE).evm.privateKey();
  setAppLogger({ info: (o, m) => logs.push(JSON.stringify({ o, m })), warn: (o, m) => logs.push(JSON.stringify({ o, m })), error: (o, m) => logs.push(JSON.stringify({ o, m })) });
  app = Fastify();
  await app.register(custodyEvmSendRoutes, { provider, flags: on, limits: () => limits, client: () => (rpc ? client : null) });
  await app.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1; state.frozen = false; limits = custodyLimitsFromEnv({}); rpc = "https://rpc.invalid"; logs.length = 0; seedN = 0;
  vi.clearAllMocks();
  client.getChainId.mockResolvedValue(11155111); client.getBalance.mockResolvedValue(10n ** 18n);
  client.sendRawTransaction.mockImplementation(async (raw: `0x${string}`) => keccak256(raw));
  client.getTransactionReceipt.mockResolvedValue(null); client.getBlockNumber.mockResolvedValue(1000n);
  await pg.exec("TRUNCATE custody_evm_transfers RESTART IDENTITY; TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'evm','sepolia',$1,'e',true,0)", [EVM]);
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", [await sealForEscrow(provider, PHRASE, { userId: 1, kind: "phrase" })]);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("POST /api/v1/custody/evm/send", () => {
  it("signs the exact Sepolia transaction with the wallet's key, stores it and broadcasts", async () => {
    const res = await send();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("broadcast");
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    const raw = client.sendRawTransaction.mock.calls[0][0];
    expect(body.hash).toBe(keccak256(raw));
    const tx = parseTransaction(raw) as any;
    expect(tx).toMatchObject({ type: "eip1559", chainId: 11155111, to: DEST, value: 5n * FINNEY, nonce: 3, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    expect((await recoverTransactionAddress({ serializedTransaction: raw as any })).toLowerCase()).toBe(EVM.toLowerCase());
    const rows = await rowsOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 1, from_address: EVM.toLowerCase(), to_address: DEST, value_wei: String(5n * FINNEY), nonce: 3, hash: body.hash, state: "broadcast" });
    expect((await audits()).map((a) => a.action)).toEqual(["wallet_key_escrow_open", "wallet_custody_sign", "custody_send"]);
  });

  it("refuses a wrong password with 403, opens no escrow and stores nothing", async () => {
    const res = await send({ password: "nope" });
    expect(res.statusCode).toBe(403);
    expect((await audits()).map((a) => a.action)).toEqual(["wallet_custody_sign_denied"]);
    expect(await rowsOf()).toHaveLength(0);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses when the balance does not cover the value plus the maximum fee", async () => {
    client.getBalance.mockResolvedValue(5n * FINNEY + 41_999_999_999_999n);
    const res = await send();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not enough/i);
    expect(await rowsOf()).toHaveLength(0);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
    client.getBalance.mockResolvedValue(5n * FINNEY + 42_000_000_000_000n);
    expect((await send()).statusCode).toBe(200);
  });

  it("refuses over the per-transaction limit and audits custody_limit_refused", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_EVM_TX_WEI: String(10n * FINNEY) });
    const res = await send({ amountWei: String(10n * FINNEY + 1n) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/limit for one payment/);
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(["custody_limit_refused"]);
    expect(a[0].detail).toMatchObject({ chain: "evm", limit: "tx" });
    expect(await rowsOf()).toHaveLength(0);
  });

  it("counts signed, broadcast and confirmed transfers from the last 24 hours towards the daily limit", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_EVM_DAY_WEI: String(100n * FINNEY), CUSTODY_LIMIT_EVM_TX_WEI: String(100n * FINNEY) });
    await seed({ value: 30n * FINNEY, state: "signed" });
    await seed({ value: 30n * FINNEY, state: "broadcast" });
    await seed({ value: 30n * FINNEY, state: "confirmed" });
    await seed({ value: 500n * FINNEY, state: "failed" });
    await seed({ value: 500n * FINNEY, ageHours: 30 });
    await seed({ value: 500n * FINNEY, user: 2 });
    // 90 already used; the 0.042 finney fee ceiling counts too, so 10 finney no longer fits but 9 does.
    expect((await send({ amountWei: String(10n * FINNEY) })).statusCode).toBe(403);
    expect((await audits()).find((a) => a.action === "custody_limit_refused")!.detail.limit).toBe("day");
    expect((await send({ amountWei: String(9n * FINNEY) })).statusCode).toBe(200);
  });

  it("limits a first payment to a new address, but not to one this user has paid before", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_NEW_RECIPIENT_MAX_EVM_WEI: String(10n * FINNEY) });
    const refused = await send({ amountWei: String(20n * FINNEY) });
    expect(refused.statusCode).toBe(403);
    expect((await audits()).find((a) => a.action === "custody_limit_refused")!.detail.limit).toBe("new_recipient");
    await seed({ value: FINNEY, to: DEST });
    expect((await send({ amountWei: String(20n * FINNEY) })).statusCode).toBe(200);
  });

  it("refuses a from address that is not the user's, and another user's wallet", async () => {
    expect((await send({ from: "0x3333333333333333333333333333333333333333" })).statusCode).toBe(403);
    state.userId = 2;
    expect((await send()).statusCode).toBe(403);
    expect(await rowsOf()).toHaveLength(0);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses the zero address and the wallet's own address, in any letter case", async () => {
    expect((await send({ to: ZERO })).statusCode).toBe(400);
    expect((await send({ to: EVM })).statusCode).toBe(400);
    expect((await send({ to: EVM.toLowerCase() })).statusCode).toBe(400);
    expect(await rowsOf()).toHaveLength(0);
  });

  it("verifies the RPC chain id before signing", async () => {
    client.getChainId.mockResolvedValue(1);
    const res = await send();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/Sepolia/);
    expect((await audits()).map((a) => a.action)).toEqual([]);
    expect(await rowsOf()).toHaveLength(0);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("is idempotent: the same key signs and broadcasts once; a different payment on that key is refused", async () => {
    const k = key();
    const first = await send({ idempotencyKey: k });
    const again = await send({ idempotencyKey: k });
    expect(again.statusCode).toBe(200);
    expect(again.json().hash).toBe(first.json().hash);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(await rowsOf()).toHaveLength(1);
    expect((await audits()).filter((a) => a.action === "custody_send")).toHaveLength(1);
    expect((await send({ idempotencyKey: k, amountWei: String(6n * FINNEY) })).statusCode).toBe(409);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("keeps the signed transfer when the broadcast fails, and answers 202 with its hash", async () => {
    client.sendRawTransaction.mockRejectedValueOnce(new Error("rpc down https://secret-rpc.example/key123"));
    const res = await send();
    expect(res.statusCode).toBe(202);
    expect(res.body).not.toContain("secret-rpc");
    const row = (await rowsOf())[0];
    expect(row.state).toBe("signed");
    expect(res.json()).toMatchObject({ status: "unknown", state: "signed", hash: row.hash,
      error: "The payment was signed but could not be confirmed as sent. Check the transfer list before trying again." });
  });

  it("answers 202 with the hash, not 'Nothing was lost', when the broadcast went out but the state update failed", async () => {
    await pg.exec("ALTER TABLE custody_evm_transfers ADD CONSTRAINT no_broadcast CHECK (state <> 'broadcast')");
    try {
      const res = await send();
      expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ status: "unknown", state: "signed", hash: keccak256(client.sendRawTransaction.mock.calls[0][0]) });
      expect(res.body).not.toMatch(/Nothing was lost/);
    } finally { await pg.exec("ALTER TABLE custody_evm_transfers DROP CONSTRAINT no_broadcast"); }
  });

  it("answers 202 for a retry with the same key while the stored transfer is still only signed, and signs nothing new", async () => {
    const k = key();
    client.sendRawTransaction.mockRejectedValueOnce(new Error("timeout"));
    const first = await send({ idempotencyKey: k });
    const again = await send({ idempotencyKey: k });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ status: "unknown", state: "signed", hash: first.json().hash });
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(await rowsOf()).toHaveLength(1);
  });

  it("still says nothing was lost when the failure came before anything was signed", async () => {
    client.estimateFeesPerGas.mockRejectedValueOnce(new Error("rpc down"));
    const res = await send();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("The payment could not be completed right now. Nothing was lost; try again.");
    expect(await rowsOf()).toHaveLength(0);
  });

  it("validates the body", async () => {
    for (const bad of [{ amountWei: "0" }, { amountWei: "1.5" }, { amountWei: 5 }, { to: "0x123" }, { to: "nope" }, { from: "nope" }, { idempotencyKey: "short" }, { password: "" }, { extra: 1 }]) {
      expect((await send(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await rowsOf()).toHaveLength(0);
  });

  it("is off when server signing is off and when no RPC is configured", async () => {
    const gated = Fastify();
    await gated.register(custodyEvmSendRoutes, { provider, flags: { ...on, serverSigning: false }, client: () => client });
    const off = await send({}, gated);
    expect(off.statusCode).toBe(503);
    expect(off.json().error).toBe("Sending from Amma-held wallets is not switched on here.");
    await gated.close();
    rpc = undefined;
    expect((await send()).statusCode).toBe(503);
  });

  it("shares one daily budget across all of the user's Amma wallets, and counts the fee ceiling", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_EVM_DAY_WEI: String(100n * FINNEY), CUSTODY_LIMIT_EVM_TX_WEI: String(100n * FINNEY) });
    await pg.query(`INSERT INTO custody_evm_transfers(user_id,from_address,to_address,value_wei,nonce,hash,state,idempotency_key)
      VALUES (1,'0x4444444444444444444444444444444444444444',$1,$2,0,$3,'confirmed','other-wallet-1')`, [DEST2, String(95n * FINNEY), "0x" + "9".repeat(64)]);
    expect((await send({ amountWei: String(5n * FINNEY) })).statusCode).toBe(403);
    expect((await send({ amountWei: String(4n * FINNEY) })).statusCode).toBe(200);
  });

  it("creates nothing for a frozen account, a self-signing account, or a wallet without a derivation index", async () => {
    state.frozen = true;
    expect((await send()).statusCode).toBe(423);
    state.frozen = false;
    await pg.exec("UPDATE users SET signing_mode='self'");
    expect((await send()).statusCode).toBe(403);
    await pg.exec("UPDATE users SET signing_mode='delegated'; UPDATE user_wallets SET derivation_index = NULL");
    expect((await send()).statusCode).toBe(403);
    await pg.exec("UPDATE user_wallets SET derivation_index = 0; UPDATE wallet_key_escrow SET origin = 'client'");
    expect((await send()).statusCode).toBe(403);
    expect(await rowsOf()).toHaveLength(0);
    expect((await audits()).map((a) => a.action).filter((a) => a !== "wallet_custody_sign_denied")).toEqual([]);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("lets only one of several parallel sends through when the daily budget fits one", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_EVM_DAY_WEI: String(10n * FINNEY), CUSTODY_LIMIT_EVM_TX_WEI: String(10n * FINNEY) });
    const results = await Promise.all([1, 2, 3, 4].map(() => send({ amountWei: String(6n * FINNEY) })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(3);
    expect(await rowsOf()).toHaveLength(1);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast when the send cannot be recorded in the audit log", async () => {
    await pg.exec("ALTER TABLE audit_logs ADD CONSTRAINT no_send CHECK (action <> 'custody_send')");
    try {
      expect((await send()).statusCode).toBe(503);
      expect(client.sendRawTransaction).not.toHaveBeenCalled();
      expect((await rowsOf())[0].state).toBe("failed");
    } finally { await pg.exec("ALTER TABLE audit_logs DROP CONSTRAINT no_send"); }
  });

  it("refuses when the RPC's fees are above the testnet fee ceiling, before signing anything", async () => {
    client.estimateFeesPerGas.mockResolvedValueOnce({ maxFeePerGas: 101_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const high = await send();
    expect(high.statusCode).toBe(503);
    expect(high.json().error).toMatch(/fees are unusually high/);
    client.estimateFeesPerGas.mockResolvedValueOnce({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 101_000_000_000n });
    expect((await send()).statusCode).toBe(503);
    expect(await rowsOf()).toHaveLength(0);
    expect((await audits()).map((a) => a.action)).toEqual([]);
    client.estimateFeesPerGas.mockResolvedValueOnce({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 100_000_000_000n });
    limits = custodyLimitsFromEnv({ CUSTODY_EVM_MAX_FEE_GWEI: "100" });
    expect((await send()).statusCode).toBe(200);
  });

  it("counts the fee ceiling in the per-payment limit as well as the daily one", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_EVM_TX_WEI: String(10n * FINNEY) });
    const res = await send({ amountWei: String(10n * FINNEY) });
    expect(res.statusCode).toBe(403);
    expect((await audits()).find((a) => a.action === "custody_limit_refused")!.detail.limit).toBe("tx");
    expect((await send({ amountWei: String(9n * FINNEY) })).statusCode).toBe(200);
  });

  it("never puts the phrase, password or private key in the response, logs or audit rows", async () => {
    const res = await send();
    await send({ password: "wrong-pw-1" });
    const all = res.body + logs.join("") + JSON.stringify(await audits()) + JSON.stringify(await rowsOf());
    expect(evmKey).toMatch(/^0x[0-9a-f]{64}$/);
    for (const secret of [PASSWORD, "wrong-pw-1", "illness", "bargain", evmKey, evmKey.slice(2)]) expect(all).not.toContain(secret);
  });
});

describe("GET /api/v1/custody/evm/transfers", () => {
  it("lists the user's transfers for a wallet, newest first", async () => {
    await seed({ value: FINNEY }); await seed({ value: 2n * FINNEY }); await seed({ value: 9n * FINNEY, user: 2 });
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json().transfers.map((t: any) => t.amountWei)).toEqual([String(2n * FINNEY), String(FINNEY)]);
    expect(res.json().transfers[0]).toMatchObject({ from: EVM.toLowerCase(), to: DEST2, state: "confirmed" });
  });

  it("refuses a wallet that is not the user's", async () => {
    expect((await list("0x3333333333333333333333333333333333333333")).statusCode).toBe(403);
    expect((await list("nope")).statusCode).toBe(400);
  });

  it("moves a broadcast transfer to confirmed at 2 confirmations, failed when reverted, and leaves 1 confirmation alone", async () => {
    await seed({ value: FINNEY, state: "broadcast" }); await seed({ value: FINNEY, state: "broadcast" });
    await seed({ value: FINNEY, state: "broadcast" }); await seed({ value: FINNEY, state: "signed" });
    const h = (i: number) => "0x" + i.toString(16).padStart(64, "0");
    client.getBlockNumber.mockResolvedValue(1001n);
    client.getTransactionReceipt.mockImplementation(async (hash: string) => {
      if (hash === h(1)) return { status: "success", blockNumber: 1000n };      // 2 confirmations
      if (hash === h(2)) return { status: "success", blockNumber: 1001n };      // 1 confirmation
      if (hash === h(3)) return { status: "reverted", blockNumber: 1001n };
      return null;                                                              // still unknown
    });
    const res = await list();
    const byHash = Object.fromEntries(res.json().transfers.map((t: any) => [t.hash, t.state]));
    expect(byHash).toEqual({ [h(1)]: "confirmed", [h(2)]: "broadcast", [h(3)]: "failed", [h(4)]: "signed" });
    expect((await rowsOf()).map((r) => r.state)).toEqual(["confirmed", "broadcast", "failed", "signed"]);
  });

  it("marks other signed or broadcast transfers with the same nonce failed once one is confirmed", async () => {
    await seed({ value: FINNEY, state: "confirmed", nonce: 5 });
    await seed({ value: FINNEY, state: "broadcast", nonce: 5 });
    await seed({ value: FINNEY, state: "signed", nonce: 5 });
    await seed({ value: FINNEY, state: "broadcast", nonce: 6 });
    rpc = undefined;
    const res = await list();
    expect(res.statusCode).toBe(200);
    expect((await rowsOf()).map((r) => [r.nonce, r.state])).toEqual([[5, "confirmed"], [5, "failed"], [5, "failed"], [6, "broadcast"]]);
  });

  it("still lists when the RPC is not configured or a receipt lookup fails", async () => {
    await seed({ value: FINNEY, state: "broadcast" });
    client.getTransactionReceipt.mockRejectedValue(new Error("down"));
    expect((await list()).json().transfers[0].state).toBe("broadcast");
    rpc = undefined;
    expect((await list()).statusCode).toBe(200);
  });
});

describe("ETH_SEND_SIMULATE guard", () => {
  const sim = (changes: any[], error: string | null = null) => ({ changes, gasUsed: 21000n, error });
  const expectedOut = { asset: "ETH", direction: "out" as const, amount: "0.005", kind: "native" as const, contract: null, raw: String(5n * FINNEY), counterparty: DEST };
  const build = async (simulate: any) => {
    const a = Fastify();
    await a.register(custodyEvmSendRoutes, { provider, flags: on, limits: () => limits, client: () => client, simulate });
    await a.ready();
    return a;
  };

  it("sends when the simulation shows only the expected ETH out", async () => {
    const simulate = vi.fn(async () => sim([expectedOut]));
    const a = await build(simulate);
    const res = await send({}, a);
    expect(res.statusCode).toBe(200);
    expect(simulate).toHaveBeenCalledWith(expect.objectContaining({ from: EVM.toLowerCase(), to: DEST, value: 5n * FINNEY, gas: 21000n, maxFeePerGas: expect.any(BigInt), maxPriorityFeePerGas: expect.any(BigInt) }));
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
    await a.close();
  });

  it("refuses with the plain message, signs nothing and stores nothing when something else would leave the wallet", async () => {
    for (const extra of [
      { asset: "USDC", direction: "out", amount: "100", kind: "token", contract: "0x" + "c".repeat(40), raw: "100", counterparty: DEST },
      { asset: "DAI", direction: "out", amount: "1", kind: "approval", contract: null, raw: "1", counterparty: DEST },
      { ...expectedOut, raw: String(6n * FINNEY) },
    ]) {
      const a = await build(vi.fn(async () => sim(extra.raw === String(6n * FINNEY) ? [extra] : [expectedOut, extra])));
      const res = await send({}, a);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("This transaction would move more than you asked. It was not sent.");
      await a.close();
    }
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await rowsOf()).toHaveLength(0);
    expect((await audits()).map((x) => x.action)).not.toContain("wallet_custody_sign");
  });

  it("does not block on incoming extras, refuses a simulated revert, and does not block when the check cannot run", async () => {
    const incoming = { asset: "SCAM", direction: "in" as const, amount: "1", kind: "token" as const, contract: null, raw: "1", counterparty: DEST };
    let a = await build(async () => sim([expectedOut, incoming]));
    expect((await send({}, a)).statusCode).toBe(200);
    await a.close();
    a = await build(async () => sim([], "execution reverted"));
    const reverted = await send({}, a);
    expect(reverted.statusCode).toBe(400);
    expect(reverted.json().error).toBe("This transaction would not go through. It was not sent.");
    await a.close();
    a = await build(async () => { throw Object.assign(new Error("https://eth.invalid/v2/SECRETKEY123"), { code: "network" }); });
    expect((await send({ amountWei: String(7n * FINNEY) }, a)).statusCode).toBe(200); // another amount: the same signed transaction would repeat a stored hash
    expect(logs.join("")).not.toContain("SECRETKEY123");
    await a.close();
  });

  it("is off by default: the normal route sends without any simulation", async () => {
    expect((await send()).statusCode).toBe(200);
  });
});

describe("ETH_SEND_SIMULATE misconfiguration (fail-open, but loud)", () => {
  const ALCHEMY = "https://eth-sepolia.g.alchemy.com/v2/SECRETKEY123";
  const withEnv = async (env: Record<string, string | undefined>, fetchImpl: any, run: (a: FastifyInstance) => Promise<void>) => {
    const saved = { ...process.env };
    Object.assign(process.env, { ETH_SEND_SIMULATE: "on" }, env);
    for (const k of Object.keys(env)) if (env[k] === undefined) delete process.env[k];
    try {
      const a = Fastify();
      await a.register(custodyEvmSendRoutes, { provider, flags: on, limits: () => limits, client: () => client, fetch: fetchImpl });
      await a.ready();
      try { await run(a); } finally { await a.close(); }
    } finally { for (const k of ["ETH_SEND_SIMULATE", "CUSTODY_SEPOLIA_RPC_URL", "WELCOME_SEPOLIA_RPC_URL"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
  const codes = () => logs.map((l) => JSON.parse(l)).filter((l) => l.m === "custody_send_evm_simulation_unavailable").map((l) => l.o.reason);

  it("warns once at start-up with a distinct code, and still sends", async () => {
    await withEnv({ CUSTODY_SEPOLIA_RPC_URL: undefined, WELCOME_SEPOLIA_RPC_URL: undefined }, undefined, async (a) => {
      const w = logs.map((l) => JSON.parse(l)).filter((l) => /ETH_SEND_SIMULATE is on/.test(l.m));
      expect(w).toHaveLength(1);
      expect(w[0].o.reason).toBe("no_rpc");
      expect((await send({}, a)).statusCode).toBe(200);
      expect(codes()).toEqual(["no_rpc"]);
    });
    logs.length = 0;
    await withEnv({ CUSTODY_SEPOLIA_RPC_URL: "https://rpc.example.com/v1/SECRETKEY123" }, undefined, async (a) => {
      expect(logs.map((l) => JSON.parse(l)).filter((l) => /ETH_SEND_SIMULATE is on/.test(l.m))[0].o.reason).toBe("not_alchemy");
      expect((await send({ amountWei: String(6n * FINNEY) }, a)).statusCode).toBe(200);
      expect(codes()).toEqual(["not_alchemy"]);
    });
    expect(logs.join("")).not.toContain("SECRETKEY123");
  });

  it("does not warn when the URL is an https Alchemy URL, and logs the failure cause when the call fails", async () => {
    const cases: [string, any][] = [
      ["network", async () => { throw new Error(ALCHEMY); }],
      ["http_500", async () => ({ ok: false, status: 500, json: async () => ({}) })],
      ["rpc_-32000", async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32000 } }) })],
    ];
    let amount = 8n;
    for (const [code, f] of cases) {
      logs.length = 0;
      await withEnv({ CUSTODY_SEPOLIA_RPC_URL: ALCHEMY }, f, async (a) => {
        expect(logs.map((l) => JSON.parse(l)).filter((l) => /ETH_SEND_SIMULATE is on/.test(l.m))).toHaveLength(0);
        expect((await send({ amountWei: String(amount++ * FINNEY) }, a)).statusCode).toBe(200);
        expect(codes()).toEqual([code]);
      });
      expect(logs.join("")).not.toContain("SECRETKEY123");
    }
  });

  it("end to end through the default eth_simulateV1 path: sends on the expected ETH only, refuses an extra token out or a revert", async () => {
    const respond = (result: unknown) => async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const amount = 20n * FINNEY;
    await withEnv({ CUSTODY_SEPOLIA_RPC_URL: ALCHEMY }, respond(simResult(okCall([nativeLog(EVM, DEST, amount)]))), async (a) => {
      expect((await send({ amountWei: String(amount) }, a)).statusCode).toBe(200);
    });
    await withEnv({ CUSTODY_SEPOLIA_RPC_URL: ALCHEMY }, respond(simResult(okCall([nativeLog(EVM, DEST, amount), erc20Log(TOKEN, EVM, DEST2, 5n)]))), async (a) => {
      const r = await send({ amountWei: String(amount + 1n) }, a);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe(SEND_MOVES_MORE);
    });
    await withEnv({ CUSTODY_SEPOLIA_RPC_URL: ALCHEMY }, respond(simResult(revertedCall())), async (a) => {
      const r = await send({ amountWei: String(amount + 2n) }, a);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("This transaction would not go through. It was not sent.");
    });
  });

  it("sends the signing gas limit in the simulated call, and refuses with a clear reason (logged insufficient_funds) on -38014", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -38014, message: "insufficient funds" } }) }));
    await withEnv({ CUSTODY_SEPOLIA_RPC_URL: ALCHEMY }, f, async (a) => {
      await new Promise((r) => setTimeout(r, 20));
      logs.length = 0;
      const r = await send({ amountWei: String(30n * FINNEY) }, a);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe("Not enough ETH in this wallet to cover the amount and the network fee.");
      expect(logs.map((l) => JSON.parse(l)).filter((l) => l.o?.reason === "insufficient_funds")).toHaveLength(1);
      const body = JSON.parse((f.mock.calls.pop() as any)[1].body);
      expect(body.params[0].blockStateCalls[0].calls[0].gas).toBe("0x5208");
    });
  });

  it("probes the simulation once at start-up and warns when the RPC plan does not support it", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: { code: -32600, message: "Unsupported method" } }) }));
    await withEnv({ CUSTODY_SEPOLIA_RPC_URL: ALCHEMY }, f, async () => {
      await new Promise((r) => setTimeout(r, 20));
      const w = logs.map((l) => JSON.parse(l)).filter((l) => /simulation not available on this RPC plan/.test(l.m));
      expect(w).toHaveLength(1);
      expect(w[0].o).toEqual({ reason: "rpc_unsupported" });
      expect(f).toHaveBeenCalledTimes(1);
    });
  });

  it("does not warn after the probe when simulation works, and does not probe when the flag is off", async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: [{ calls: [{ status: "0x1", gasUsed: "0x5208", logs: [] }] }] }) }));
    await withEnv({ CUSTODY_SEPOLIA_RPC_URL: ALCHEMY }, ok, async () => {
      await new Promise((r) => setTimeout(r, 20));
      expect(logs.filter((l) => /RPC plan/.test(l))).toHaveLength(0);
      expect(ok).toHaveBeenCalledTimes(1);
    });
    const off = vi.fn();
    const a = Fastify();
    await a.register(custodyEvmSendRoutes, { provider, flags: on, limits: () => limits, client: () => client, fetch: off as any });
    await a.ready(); await a.close();
    expect(off).not.toHaveBeenCalled();
  });
});
