import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { keccak256 } from "viem";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { applyCustodyV3 } from "../db/migrations/custody-v3";
import { applyCustodyV4 } from "../db/migrations/custody-v4";
import { applyCustodyV5 } from "../db/migrations/custody-v5";
import { applyPaymentStorage } from "../db/migrations/xrpl-payments";
import { applyReconciliationStorage } from "../db/migrations/xrpl-reconciliation";
import { applyIntegrationStorage } from "../db/migrations/xrpl-integration";
import { LocalMasterKeyProvider, sealForEscrow } from "../lib/key-wrapper";
import { custodyLimitsFromEnv } from "../lib/custody-limits";
import { custodyPreflight } from "../lib/custody-preflight";
import { checkCustodyPassword, checkCustodyPasswordOnly, custodySignStellar, signWithCustody } from "../lib/custody-sign";
import { CustodyRefused, withDelegatedKey } from "../lib/custody-signer";
import { CUSTODY_NOT_AVAILABLE, custodyFlagsFromEnv, type CustodyFlags } from "../lib/custody-flags";
import { deriveAllChains } from "../lib/one-phrase";
import { setAppLogger } from "../lib/app-log";
import { LMS_CLAIM_PREFIX } from "../lib/lms-claim";

// Mainnet custody allow-list: only the ids in CUSTODY_MAINNET_USER_IDS may use Amma custody on mainnet. User 1 is listed, user 2 is not.
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1 }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "public", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y", JWT_EXPIRES_IN: 900, XRPL: { enabled: true }, XRPL_PAYMENTS_ENABLED: true } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => false }));

import { custodyRoutes } from "./custody";
import { custodySendRoutes } from "./custody-send";
import { custodyEvmSendRoutes, type EvmClient } from "./custody-evm-send";
import { custodyLmsClaimRoutes } from "./custody-lms-claim";
import { keyEscrowRoutes } from "./key-escrow";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PASSWORD = "correct horse battery staple";
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const MAIN_ENV = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", CUSTODY_SERVER_SIGNING: "true" };
const listed: CustodyFlags = custodyFlagsFromEnv({ ...MAIN_ENV, CUSTODY_MAINNET_USER_IDS: "1" });
const emptyList: CustodyFlags = custodyFlagsFromEnv(MAIN_ENV);
const testnet: CustodyFlags = custodyFlagsFromEnv({ CUSTODY_SERVER_SIGNING: "true", CUSTODY_MAINNET_USER_IDS: "1" });
const mine = deriveAllChains(PHRASE, 0);
const DEST = "0x1111111111111111111111111111111111111111";
const client = {
  getChainId: vi.fn(async () => 1), getBalance: vi.fn(async (_a: string) => 10n ** 18n), getTransactionCount: vi.fn(async (_a: string) => 3),
  estimateGas: vi.fn(async (_a: any) => 21000n), estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })),
  sendRawTransaction: vi.fn(async (raw: `0x${string}`) => keccak256(raw)),
  getTransactionReceipt: vi.fn(async (_h: string): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null> => null),
  getBlockNumber: vi.fn(async () => 1000n),
} satisfies EvmClient;
let pg: PGlite;
let app: FastifyInstance, emptyApp: FastifyInstance, testApp: FastifyInstance, escrowApp: FastifyInstance;

const count = async () => {
  const out: Record<string, number> = {};
  for (const t of ["audit_logs", "wallet_key_escrow", "user_wallets", "custody_evm_transfers", "xrpl_payments"]) out[t] = Number(((await pg.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as any).n);
  return out;
};
const actions = async () => (await pg.query("SELECT action FROM audit_logs ORDER BY id")).rows.map((r: any) => r.action as string);
const seedFor = async (userId: number) => {
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES ($1,'phrase',$2,'local','custody')", [userId, await sealForEscrow(provider, PHRASE, { userId, kind: "phrase" })]);
  for (const [chain, network, address] of [["stellar", "public", mine.stellar.publicKey], ["evm", "ethereum", mine.evm.address]]) {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES ($1,$2,$3,$4,'w',true,0)", [userId, chain, network, address]);
  }
};
const stellarTx = () => new TransactionBuilder(new Account(mine.stellar.publicKey, "1"), { fee: "100", networkPassphrase: Networks.PUBLIC })
  .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" })).setTimeout(0).build();
const claim = () => [LMS_CLAIM_PREFIX, "claim:0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", `destination:${mine.stellar.publicKey}`, "amount_stroops:1000000",
  `expires:${new Date(Date.now() + 5 * 60_000).toISOString()}`, `nonce:${"a".repeat(64)}`].join("\n");
const wrongPw = "definitely not the password";

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4, applyCustodyV5]) await apply(conn);
  for (const apply of [applyPaymentStorage, applyReconciliationStorage, applyIntegrationStorage]) {
    await pg.transaction(tx => apply({ execute: async (s: string) => { await tx.exec(s); }, rows: async <T extends Record<string, unknown>>(s: string) => (await tx.query<T>(s)).rows }));
  }
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  await pg.query("UPDATE users SET password_hash = $1 WHERE id IN (1,2)", [await bcrypt.hash(PASSWORD, 4)]);
  setAppLogger({ info: () => {}, warn: () => {}, error: () => {} });
  const limits = () => custodyLimitsFromEnv(MAIN_ENV);
  const build = async (flags: CustodyFlags) => {
    const a = Fastify();
    await a.register(custodyRoutes, { provider, flags });
    await a.register(custodySendRoutes, { provider, flags, limits, network: {} as any, submissionGate: () => {}, hmacKey: Buffer.alloc(32, 9) });
    await a.register(custodyEvmSendRoutes, { provider, flags, limits, client: () => client });
    await a.register(custodyLmsClaimRoutes, { provider, flags });
    await a.ready();
    return a;
  };
  app = await build(listed); emptyApp = await build(emptyList); testApp = await build(testnet);
  escrowApp = Fastify(); await escrowApp.register(keyEscrowRoutes, { provider, flags: listed }); await escrowApp.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1; vi.clearAllMocks();
  await pg.exec("TRUNCATE custody_evm_transfers RESTART IDENTITY; TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; DELETE FROM xrpl_payments; UPDATE users SET signing_mode='delegated'");
});
afterAll(async () => { await Promise.all([app, emptyApp, testApp, escrowApp].map((a) => a?.close())); await pg?.close(); });

const evmBody = (password: string) => ({ from: mine.evm.address, to: DEST, amountWei: "1000000000000000", password, idempotencyKey: "idem-allowlist-0001" });
type Call = (a: FastifyInstance) => Promise<{ statusCode: number; json: () => any }>;
const routes: Record<string, Call> = {
  "POST /custody/onboard": (a) => a.inject({ method: "POST", url: "/api/v1/custody/onboard" }),
  "GET /custody/wallets": (a) => a.inject({ method: "GET", url: "/api/v1/custody/wallets" }),
  "POST /custody/wallets": (a) => a.inject({ method: "POST", url: "/api/v1/custody/wallets", payload: { chain: "evm" } }),
  "PATCH /custody/wallets": (a) => a.inject({ method: "PATCH", url: "/api/v1/custody/wallets", payload: { chain: "evm", address: mine.evm.address, active: true } }),
  "POST /custody/import": (a) => a.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "evm", address: mine.evm.address, secret: PHRASE, password: wrongPw } }),
  "GET /custody/activity": (a) => a.inject({ method: "GET", url: "/api/v1/custody/activity" }),
  "GET /custody/welcome-funding": (a) => a.inject({ method: "GET", url: "/api/v1/custody/welcome-funding" }),
  "POST /custody/evm/send": (a) => a.inject({ method: "POST", url: "/api/v1/custody/evm/send", payload: evmBody(wrongPw) }),
  "GET /custody/evm/transfers": (a) => a.inject({ method: "GET", url: `/api/v1/custody/evm/transfers?from=${mine.evm.address}` }),
  "POST /custody/xrpl/send": (a) => a.inject({ method: "POST", url: "/api/v1/custody/xrpl/send", payload: { from: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", to: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", amountDrops: "1000000", password: wrongPw, idempotencyKey: "idem-allowlist-0002" } }),
  "POST /custody/lms-claim/sign": (a) => a.inject({ method: "POST", url: "/api/v1/custody/lms-claim/sign", payload: { message: claim(), password: wrongPw } }),
};

describe("mainnet allow-list on the routes", () => {
  it.each(Object.keys(routes))("%s refuses a user who is not listed, before anything is checked, opened or written", async (name) => {
    await seedFor(2);
    state.userId = 2;
    const before = await count();
    const res = await routes[name]!(app);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(CUSTODY_NOT_AVAILABLE);
    expect(await count()).toEqual(before); // no escrow open or denial audit row (so no password check), no wallet or transfer row
    expect(await actions()).toEqual([]);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each(Object.keys(routes))("%s refuses everyone when the list is empty", async (name) => {
    await seedFor(1);
    const before = await count();
    const res = await routes[name]!(emptyApp);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(CUSTODY_NOT_AVAILABLE);
    expect(await count()).toEqual(before);
  });

  it("lets a listed user onboard and list wallets on mainnet, and reach the password check on send", async () => {
    const on = await app.inject({ method: "POST", url: "/api/v1/custody/onboard" });
    expect(on.statusCode).toBe(200);
    expect(on.json().created).toBe(true);
    const list = await app.inject({ method: "GET", url: "/api/v1/custody/wallets" });
    expect(list.statusCode).toBe(200);
    expect(list.json().wallets).toHaveLength(2);
    const bad = await routes["POST /custody/evm/send"]!(app);
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toBe("That password is not correct.");
    expect(await actions()).toContain("wallet_custody_sign_denied");
  });

  it("sends from a listed user's wallet", async () => {
    await seedFor(1);
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/evm/send", payload: evmBody(PASSWORD) });
    expect(res.statusCode).toBe(200);
    expect(client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not apply the list on testnet: the variable is ignored", async () => {
    state.userId = 2;
    const on = await testApp.inject({ method: "POST", url: "/api/v1/custody/onboard" });
    expect(on.statusCode).toBe(200);
    expect(on.json().created).toBe(true);
    expect((await testApp.inject({ method: "GET", url: "/api/v1/custody/wallets" })).statusCode).toBe(200);
  });
});

describe("mainnet allow-list in the signing helpers", () => {
  const base = (userId: number, flags = listed) => ({ provider, flags, userId, password: wrongPw, walletAddress: mine.stellar.publicKey });

  it("checkCustodyPassword, checkCustodyPasswordOnly, signWithCustody and custodySignStellar refuse before any check or write", async () => {
    await seedFor(2);
    const before = await count();
    const tx = stellarTx();
    for (const result of [
      await checkCustodyPassword({ ...base(2), tx }),
      await checkCustodyPasswordOnly({ provider, flags: listed, userId: 2, password: wrongPw }, "evm"),
      await signWithCustody({ provider, flags: listed, userId: 2, walletAddress: mine.stellar.publicKey, tx }),
      await custodySignStellar({ ...base(2), tx }),
      await checkCustodyPassword({ ...base(1, emptyList), tx }),
    ]) expect(result).toEqual({ status: 403, error: CUSTODY_NOT_AVAILABLE });
    expect(tx.signatures).toHaveLength(0);
    expect(await count()).toEqual(before);
  });

  it("custodyPreflight refuses a user who is not listed", async () => {
    await seedFor(2);
    expect(await custodyPreflight({ userId: 2, chain: "stellar", from: mine.stellar.publicKey, flags: listed })).toEqual({ status: 403, error: CUSTODY_NOT_AVAILABLE });
    expect(await custodyPreflight({ userId: 1, chain: "stellar", from: mine.stellar.publicKey, flags: emptyList })).toEqual({ status: 403, error: CUSTODY_NOT_AVAILABLE });
  });

  it("withDelegatedKey refuses before opening escrow", async () => {
    await seedFor(2);
    const use = vi.fn(async () => 1);
    await expect(withDelegatedKey({ provider, flags: listed, userId: 2, chain: "stellar", expectedAddress: mine.stellar.publicKey, reason: "t" }, use)).rejects.toMatchObject({ code: "not-allowed" });
    await expect(withDelegatedKey({ provider, flags: emptyList, userId: 1, chain: "stellar", expectedAddress: mine.stellar.publicKey, reason: "t" }, use)).rejects.toBeInstanceOf(CustodyRefused);
    expect(use).not.toHaveBeenCalled();
    expect(await actions()).toEqual([]);
  });

  it("a listed user signs on mainnet", async () => {
    await seedFor(1);
    const tx = stellarTx();
    expect(await custodySignStellar({ ...base(1), password: PASSWORD, tx })).toBeNull();
    expect(tx.signatures).toHaveLength(1);
  });

  it("testnet flags ignore the list", async () => {
    await seedFor(2);
    const r = await custodyPreflight({ userId: 2, chain: "stellar", from: mine.stellar.publicKey, flags: testnet });
    expect(r?.error).not.toBe(CUSTODY_NOT_AVAILABLE);
  });
});

describe("mainnet allow-list on key backup", () => {
  it("reports key backup off and refuses saving a phrase for a user who is not listed", async () => {
    state.userId = 2;
    const status = await escrowApp.inject({ method: "GET", url: "/api/v1/key-escrow/status" });
    expect(status.json()).toEqual({ enabled: false, hasPhrase: false });
    const before = await count();
    const put = await escrowApp.inject({ method: "PUT", url: "/api/v1/key-escrow/phrase", payload: { phrase: PHRASE } });
    expect(put.statusCode).toBe(403);
    expect(put.json().error).toBe(CUSTODY_NOT_AVAILABLE);
    expect(await count()).toEqual(before);
  });
  it("still works for a listed user", async () => {
    expect((await escrowApp.inject({ method: "GET", url: "/api/v1/key-escrow/status" })).json().enabled).toBe(true);
    expect((await escrowApp.inject({ method: "PUT", url: "/api/v1/key-escrow/phrase", payload: { phrase: PHRASE } })).statusCode).toBe(200);
  });
});
