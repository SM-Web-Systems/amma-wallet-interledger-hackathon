import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { Account, Asset, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { keccak256, parseTransaction } from "viem";
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
import { TOKEN_REFUSED_ERROR, custodyLimitsFromEnv } from "../lib/custody-limits";
import { custodyPreflight } from "../lib/custody-preflight";
import { checkCustodyPassword, releaseCustodyDay, signWithCustody } from "../lib/custody-sign";
import { deriveAllChains } from "../lib/one-phrase";
import { setAppLogger } from "../lib/app-log";
import { LMS_CLAIM_PREFIX } from "../lib/lms-claim";
import type { CustodyFlags } from "../lib/custody-flags";

// Custody mainnet mode (MAINNET_CUSTODY=on): the same routes, on public / mainnet / ethereum, with mocked chains.
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "public", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y", JWT_EXPIRES_IN: 900, XRPL: { enabled: true }, XRPL_PAYMENTS_ENABLED: true } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { custodyRoutes } from "./custody";
import { custodySendRoutes } from "./custody-send";
import { custodyEvmSendRoutes, evmClientFromEnv, type EvmClient } from "./custody-evm-send";
import { custodyLmsClaimRoutes } from "./custody-lms-claim";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const DEVICE_PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PASSWORD = "correct horse battery staple";
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const main: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50, mainnet: true, mainnetUserIds: new Set([1]) };
const test: CustodyFlags = { ...main, mainnet: undefined };
const MAIN_ENV = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" };
const mine = deriveAllChains(PHRASE, 0);
const device = deriveAllChains(DEVICE_PHRASE);
const DEST = "0x1111111111111111111111111111111111111111";
const FINNEY = 10n ** 15n;
const client = {
  getChainId: vi.fn(async () => 1),
  getBalance: vi.fn(async (_a: string) => 10n ** 18n),
  getTransactionCount: vi.fn(async (_a: string) => 3),
  estimateGas: vi.fn(async (_a: any) => 21000n),
  estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n })),
  sendRawTransaction: vi.fn(async (raw: `0x${string}`) => keccak256(raw)),
  getTransactionReceipt: vi.fn(async (_h: string): Promise<{ status: "success" | "reverted"; blockNumber: bigint } | null> => null),
  getBlockNumber: vi.fn(async () => 1000n),
} satisfies EvmClient;
const logs: string[] = [];
let pg: PGlite, app: FastifyInstance, testApp: FastifyInstance;

const rows = async () => (await pg.query("SELECT chain, network, public_key, derivation_index, is_active FROM user_wallets WHERE user_id=1 ORDER BY chain, id")).rows as any[];
const audits = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];
const seedPhrase = async () => pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", [await sealForEscrow(provider, PHRASE, { userId: 1, kind: "phrase" })]);
const seedWallet = (chain: string, network: string, address: string, idx: number | null = 0) =>
  pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,$1,$2,$3,'w',true,$4)", [chain, network, address, idx]);
const evmSend = (over: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/v1/custody/evm/send",
  payload: { from: mine.evm.address, to: DEST, amountWei: String(FINNEY), password: PASSWORD, idempotencyKey: `idem-${randomUUID()}`, ...over } });
const claim = (destination: string) => [LMS_CLAIM_PREFIX, "claim:0c6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", `destination:${destination}`, "amount_stroops:1000000",
  `expires:${new Date(Date.now() + 5 * 60_000).toISOString()}`, `nonce:${"a".repeat(64)}`].join("\n");

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
  const l = (o: unknown, m?: string) => logs.push(JSON.stringify({ o, m }));
  setAppLogger({ info: l, warn: l, error: l });
  const limits = () => custodyLimitsFromEnv(MAIN_ENV);
  app = Fastify();
  await app.register(custodyRoutes, { provider, flags: main });
  await app.register(custodySendRoutes, { provider, flags: main, limits, network: {} as any, submissionGate: () => {}, hmacKey: Buffer.alloc(32, 9) });
  await app.register(custodyEvmSendRoutes, { provider, flags: main, limits, client: () => client });
  await app.register(custodyLmsClaimRoutes, { provider, flags: main });
  await app.ready();
  testApp = Fastify();
  await testApp.register(custodyRoutes, { provider, flags: test });
  await testApp.register(custodyLmsClaimRoutes, { provider, flags: test });
  await testApp.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1; state.frozen = false; logs.length = 0; vi.clearAllMocks();
  client.getChainId.mockResolvedValue(1);
  await pg.exec("TRUNCATE custody_evm_transfers RESTART IDENTITY; TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
});
afterAll(async () => { await app?.close(); await testApp?.close(); await pg?.close(); });

describe("onboarding and wallet routes on mainnet", () => {
  it("onboarding writes public, mainnet and ethereum rows, and the list shows them", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/onboard" });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(true);
    expect((await rows()).map((r) => [r.chain, r.network, r.derivation_index, r.is_active])).toEqual([
      ["evm", "ethereum", 0, true], ["stellar", "public", 0, true]]);
    expect(res.json().wallets.xrpl).toBeUndefined();
    const list = await app.inject({ method: "GET", url: "/api/v1/custody/wallets" });
    expect(list.json().wallets.map((w: any) => [w.chain, w.network])).toEqual([["evm", "ethereum"], ["stellar", "public"]]);
    const again = await app.inject({ method: "POST", url: "/api/v1/custody/onboard" });
    expect(again.json().created).toBe(false);
    expect(Object.values(again.json().wallets).every((v) => typeof v === "string")).toBe(true);
  });

  it("the list shows only the active network's wallets", async () => {
    await app.inject({ method: "POST", url: "/api/v1/custody/onboard" });
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'stellar','testnet',$1,'old',false,0)", [Keypair.random().publicKey()]);
    const onMain = (await app.inject({ method: "GET", url: "/api/v1/custody/wallets" })).json().wallets;
    expect(onMain.every((w: any) => ["public", "mainnet", "ethereum"].includes(w.network))).toBe(true);
    expect(onMain).toHaveLength(2);
    const onTest = (await testApp.inject({ method: "GET", url: "/api/v1/custody/wallets" })).json().wallets;
    expect(onTest.map((w: any) => w.network)).toEqual(["testnet"]);
  });

  it("refuses XRP on mainnet when adding a wallet, before the phrase is opened", async () => {
    await app.inject({ method: "POST", url: "/api/v1/custody/onboard" });
    await pg.exec("TRUNCATE audit_logs RESTART IDENTITY");
    const x = await app.inject({ method: "POST", url: "/api/v1/custody/wallets", payload: { chain: "xrpl" } });
    expect(x.statusCode).toBe(400);
    expect(x.json().error).toMatch(/test network/);
    expect((await audits()).map((a) => a.action)).not.toContain("wallet_key_escrow_open");
    expect((await rows()).filter((r) => r.chain === "xrpl")).toHaveLength(0);
  });
  it("adds Ethereum wallets on mainnet and renames or promotes them", async () => {
    await app.inject({ method: "POST", url: "/api/v1/custody/onboard" });
    const e = await app.inject({ method: "POST", url: "/api/v1/custody/wallets", payload: { chain: "evm", name: "Two" } });
    expect(e.json().wallet).toMatchObject({ chain: "evm", network: "ethereum", index: 1, name: "Two" });
    const p = await app.inject({ method: "PATCH", url: "/api/v1/custody/wallets", payload: { chain: "evm", address: e.json().wallet.address, active: true } });
    expect(p.statusCode).toBe(200);
    expect((await rows()).filter((r) => r.chain === "evm" && r.is_active).map((r) => r.derivation_index)).toEqual([1]);
  });
});

describe("import on mainnet", () => {
  it("writes a row on the mainnet network", async () => {
    await seedPhrase();
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json().wallet).toMatchObject({ chain: "evm", network: "ethereum", imported: true });
  });
  it("refuses an XRP import on mainnet before the password is checked or any key is used", async () => {
    await seedPhrase();
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "xrpl", address: device.xrpl.address, secret: DEVICE_PHRASE, password: "wrong" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/test network/);
    expect((await audits()).map((a) => a.action)).toEqual([]);
    expect((await pg.query("SELECT count(*)::int AS n FROM wallet_key_escrow WHERE origin = 'import'")).rows[0]).toEqual({ n: 0 });
  });
  it("refuses an address this account already holds on the other (testnet) network, and the reverse on testnet", async () => {
    await seedPhrase();
    await seedWallet("evm", "sepolia", device.evm.address, null);
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE, password: PASSWORD } });
    expect(res.statusCode).toBe(409);
    await pg.exec("DELETE FROM user_wallets");
    await seedWallet("evm", "ethereum", device.evm.address, null);
    const rev = await testApp.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE, password: PASSWORD } });
    expect(rev.statusCode).toBe(409);
  });
});

describe("Ethereum send on mainnet", () => {
  beforeEach(async () => { await seedPhrase(); await seedWallet("evm", "ethereum", mine.evm.address); });

  it("signs with chainId 1 and stores the transfer", async () => {
    const res = await evmSend();
    expect(res.statusCode).toBe(200);
    const tx = parseTransaction(client.sendRawTransaction.mock.calls[0][0]) as any;
    expect(tx).toMatchObject({ chainId: 1, to: DEST, value: FINNEY });
    const list = await app.inject({ method: "GET", url: `/api/v1/custody/evm/transfers?from=${mine.evm.address}` });
    expect(list.statusCode).toBe(200);
    expect(list.json().transfers).toHaveLength(1);
  });
  it("refuses an RPC whose chain id is not 1, before signing, and says so", async () => {
    client.getChainId.mockResolvedValue(11155111);
    const res = await evmSend();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/not on Ethereum mainnet/);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
    expect((await audits()).map((a) => a.action)).not.toContain("wallet_custody_sign");
  });
  it("does not see a Sepolia wallet", async () => {
    await pg.exec("DELETE FROM user_wallets");
    await seedWallet("evm", "sepolia", mine.evm.address);
    expect((await evmSend()).statusCode).toBe(403);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("uses the lower mainnet limits by default", async () => {
    const res = await evmSend({ amountWei: String(3n * FINNEY) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/0\.002 ETH limit/);
  });
  it("needs CUSTODY_ETH_RPC_URL on mainnet and never falls back to the Sepolia RPC settings", () => {
    expect(evmClientFromEnv({ ...MAIN_ENV, CUSTODY_SEPOLIA_RPC_URL: "https://s.invalid", WELCOME_SEPOLIA_RPC_URL: "https://w.invalid" })).toBeNull();
    expect(evmClientFromEnv({ ...MAIN_ENV, CUSTODY_ETH_RPC_URL: "https://e.invalid" })).not.toBeNull();
    expect(evmClientFromEnv({ CUSTODY_ETH_RPC_URL: "https://e.invalid" })).toBeNull();
    expect(evmClientFromEnv({ CUSTODY_SEPOLIA_RPC_URL: "https://s.invalid" })).not.toBeNull();
  });
});

describe("XRP send on mainnet", () => {
  it("is refused with 503 before the password is checked, because the XRP payment pipeline is testnet-only", async () => {
    await seedPhrase(); await seedWallet("xrpl", "mainnet", mine.xrpl.address);
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/xrpl/send",
      payload: { from: mine.xrpl.address, to: device.xrpl.address, amountDrops: "1000000", password: "wrong", idempotencyKey: randomUUID() } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("XRP sending from Amma-held wallets isn't available on mainnet yet.");
    expect((await audits()).filter((a) => a.action === "wallet_custody_sign_denied")).toEqual([]);
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_payments")).rows[0]).toEqual({ n: 0 });
  });
});

describe("LMS claim on mainnet", () => {
  it("signs for a public Stellar wallet", async () => {
    await seedPhrase(); await seedWallet("stellar", "public", mine.stellar.publicKey);
    const message = claim(mine.stellar.publicKey);
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/lms-claim/sign", payload: { message, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(Keypair.fromPublicKey(mine.stellar.publicKey).verify(Buffer.from(message, "utf8"), Buffer.from(res.json().signature, "base64"))).toBe(true);
  });
  it("does not sign for a testnet wallet in mainnet mode, nor a public wallet in testnet mode", async () => {
    await seedPhrase(); await seedWallet("stellar", "testnet", mine.stellar.publicKey);
    const message = claim(mine.stellar.publicKey);
    expect((await app.inject({ method: "POST", url: "/api/v1/custody/lms-claim/sign", payload: { message, password: PASSWORD } })).statusCode).toBe(403);
    await pg.exec("DELETE FROM user_wallets"); await seedWallet("stellar", "public", mine.stellar.publicKey);
    expect((await testApp.inject({ method: "POST", url: "/api/v1/custody/lms-claim/sign", payload: { message, password: PASSWORD } })).statusCode).toBe(403);
  });
});

describe("preflight and the Stellar cap on mainnet", () => {
  it("custodyPreflight looks up the network it is given", async () => {
    await seedPhrase(); await seedWallet("xrpl", "mainnet", mine.xrpl.address);
    expect(await custodyPreflight({ userId: 1, chain: "xrpl", from: mine.xrpl.address, networks: { mainnet: true, stellar: "public", xrpl: "mainnet", evm: "ethereum", evmChainId: 1 } })).toBeNull();
    expect(await custodyPreflight({ userId: 1, chain: "xrpl", from: mine.xrpl.address })).toMatchObject({ status: 403 });
  });

  const build = (op: any) => new TransactionBuilder(new Account(mine.stellar.publicKey, "1"), { fee: "100", networkPassphrase: Networks.PUBLIC }).addOperation(op).setTimeout(60).build();
  const pay = (xlm: string) => build(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: xlm }));
  const opts = (tx: any, flags: CustodyFlags) => ({ provider, flags, userId: 1, password: PASSWORD, walletAddress: mine.stellar.publicKey, tx });
  it("refuses a native payment over 10 XLM when signing on the server on mainnet, and allows up to it", async () => {
    await seedPhrase(); await seedWallet("stellar", "public", mine.stellar.publicKey);
    const over = await checkCustodyPassword(opts(pay("10.0000001"), main));
    expect(over).toMatchObject({ status: 403 });
    expect(over!.error).toMatch(/10 XLM/);
    expect(await checkCustodyPassword(opts(pay("10"), main))).toBeNull();
    expect(await checkCustodyPassword(opts(pay("5000"), test))).toBeNull();
  });
  it("refuses an account merge on mainnet", async () => {
    const tx = build(Operation.accountMerge({ destination: Keypair.random().publicKey() }));
    expect(await checkCustodyPassword(opts(tx, main))).toMatchObject({ status: 403 });
  });

  const other = Keypair.random().publicKey();
  const usd = new Asset("USD", other);
  const refusedOps: Record<string, any> = {
    setOptions: Operation.setOptions({ signer: { ed25519PublicKey: other, weight: 255 }, masterWeight: 0 }),
    invokeHostFunction: Operation.invokeContractFunction({ contract: Asset.native().contractId(Networks.PUBLIC), function: "transfer",
      args: [nativeToScVal(mine.stellar.publicKey, { type: "address" }), nativeToScVal(other, { type: "address" }), nativeToScVal(10n ** 15n, { type: "i128" })] }),
    manageBuyOffer: Operation.manageBuyOffer({ selling: Asset.native(), buying: usd, buyAmount: "1000000", price: "1" }),
    manageSellOffer: Operation.manageSellOffer({ selling: Asset.native(), buying: usd, amount: "1000000", price: "1" }),
    liquidityPoolDeposit: Operation.liquidityPoolDeposit({ liquidityPoolId: "a".repeat(64), maxAmountA: "100000", maxAmountB: "1", minPrice: "0.0000001", maxPrice: "10000000" }),
    manageData: Operation.manageData({ name: "x", value: "y" }),
    bumpSequence: Operation.bumpSequence({ bumpTo: "100" }),
    beginSponsoring: Operation.beginSponsoringFutureReserves({ sponsoredId: other }),
  };
  it.each(Object.keys(refusedOps))("refuses %s on mainnet before the password is looked at", async (name) => {
    const res = await checkCustodyPassword({ ...opts(build(refusedOps[name]), main), password: "wrong" });
    expect(res).toMatchObject({ status: 403 });
    expect(res!.error).toMatch(/can't be signed/);
    expect((await audits()).filter((a) => a.action === "wallet_custody_sign_denied")).toHaveLength(0);
  });
  it("allows payment, createAccount, both path payments and changeTrust", async () => {
    await seedPhrase(); await seedWallet("stellar", "public", mine.stellar.publicKey);
    for (const op of [
      Operation.payment({ destination: other, asset: Asset.native(), amount: "1" }),
      Operation.createAccount({ destination: other, startingBalance: "1" }),
      Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: "1", destination: other, destAsset: usd, destMin: "0.1" }),
      Operation.pathPaymentStrictReceive({ sendAsset: Asset.native(), sendMax: "1", destination: other, destAsset: usd, destAmount: "0.1" }),
      Operation.changeTrust({ asset: usd }),
    ]) expect(await checkCustodyPassword(opts(build(op), main))).toBeNull();
  });
  it("refuses an operation whose source is another account, and an operation with the platform source", async () => {
    for (const source of [other, Keypair.random().publicKey()]) {
      const tx = build(Operation.payment({ destination: other, asset: Asset.native(), amount: "1", source }));
      expect(await checkCustodyPassword(opts(tx, main))).toMatchObject({ status: 403, error: expect.stringMatching(/someone else's account/) });
    }
    expect(await checkCustodyPassword(opts(build(Operation.payment({ destination: other, asset: Asset.native(), amount: "1", source: mine.stellar.publicKey })), main))).toBeNull();
  });
  it("refuses a fee bid above the ceiling", async () => {
    const tx = new TransactionBuilder(new Account(mine.stellar.publicKey, "1"), { fee: "2000000", networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.payment({ destination: other, asset: Asset.native(), amount: "1" })).setTimeout(60).build();
    expect(await checkCustodyPassword(opts(tx, main))).toMatchObject({ status: 403, error: expect.stringMatching(/fee/) });
  });

  describe("token caps on mainnet", () => {
    const circle = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const usdc = new Asset("USDC", circle);
    const zarIssuer = Keypair.random().publicKey();
    const zarp = new Asset("ZARP", zarIssuer);
    const usdx = new Asset("USDX", zarIssuer);
    const lim = custodyLimitsFromEnv({ ...MAIN_ENV, CUSTODY_MAINNET_TOKEN_CAPS: `USDC:${circle}:usd,USDX:${zarIssuer}:usd,ZARP:${zarIssuer}:zar` });
    const tpay = (asset: Asset, amount: string) => build(Operation.payment({ destination: other, asset, amount }));
    const sign = (tx: any, limits = lim) => signWithCustody({ provider, flags: main, userId: 1, walletAddress: mine.stellar.publicKey, tx, limits });
    const tokenRows = async () => (await audits()).filter((a) => a.action === "custody_stellar_token_sign");
    beforeEach(async () => { await seedPhrase(); await seedWallet("stellar", "public", mine.stellar.publicKey); });

    it("refuses an unlisted token with the plain message before the password is looked at, and allows it on testnet", async () => {
      const unknown = () => tpay(new Asset("USDC", other), "0.5");
      expect(await checkCustodyPassword({ ...opts(unknown(), main), password: "wrong" })).toEqual({ status: 403, error: TOKEN_REFUSED_ERROR });
      expect((await audits()).filter((a) => a.action === "wallet_custody_sign_denied")).toHaveLength(0);
      expect(await checkCustodyPassword(opts(tpay(usdc, "500"), test))).toBeNull();
      const t = unknown();
      expect(await sign(t)).toEqual({ status: 403, error: TOKEN_REFUSED_ERROR });
      expect(t.signatures).toHaveLength(0);
      expect(await tokenRows()).toHaveLength(0);
    });
    it("signs an allowed token within the caps and records its own per-asset usage", async () => {
      const t = tpay(usdc, "1");
      expect(await sign(t)).toBeNull(); expect(t.signatures).toHaveLength(1);
      expect((await tokenRows()).map((r) => r.detail)).toEqual([{ asset: `USDC:${circle}`, cls: "usd", units: "10000000" }]);
    });
    it("refuses over the per-transaction cap without signing or recording", async () => {
      const t = tpay(usdc, "1.0000001");
      expect(await sign(t)).toMatchObject({ status: 403, error: expect.stringMatching(/1 USD limit for one payment/) });
      expect(t.signatures).toHaveLength(0); expect(await tokenRows()).toHaveLength(0);
      expect(await checkCustodyPassword({ ...opts(tpay(zarp, "10.0000001"), main), limits: lim })).toMatchObject({ status: 403, error: expect.stringMatching(/10 ZAR limit/) });
      expect(await checkCustodyPassword({ ...opts(tpay(zarp, "10"), main), limits: lim })).toBeNull();
    });
    it("two USD tokens share the USD cap: $5 a day in total across both, and $1 per transaction", async () => {
      const twoInOne = new TransactionBuilder(new Account(mine.stellar.publicKey, "1"), { fee: "200", networkPassphrase: Networks.PUBLIC })
        .addOperation(Operation.payment({ destination: other, asset: usdc, amount: "0.6" })).addOperation(Operation.payment({ destination: other, asset: usdx, amount: "0.6" })).setTimeout(60).build();
      expect(await sign(twoInOne)).toMatchObject({ status: 403, error: expect.stringMatching(/1 USD limit for one payment/) });
      expect(twoInOne.signatures).toHaveLength(0); expect(await tokenRows()).toHaveLength(0);
      expect(await sign(tpay(usdc, "1"))).toBeNull(); expect(await sign(tpay(usdx, "1"))).toBeNull(); expect(await sign(tpay(usdc, "1"))).toBeNull();
      expect(await sign(tpay(usdx, "1"))).toBeNull(); expect(await sign(tpay(usdc, "1"))).toBeNull();
      const t = tpay(usdx, "0.0000001");
      expect(await sign(t)).toMatchObject({ status: 403, error: expect.stringMatching(/5 USD daily limit/) });
      expect(t.signatures).toHaveLength(0);
      // The ZAR class and XLM are separate.
      expect(await sign(tpay(zarp, "10"))).toBeNull();
      expect(await sign(pay("1"))).toBeNull();
      expect((await tokenRows()).every((r) => r.detail.cls === "usd" || r.detail.cls === "zar")).toBe(true);
    });
    it("a release carries the class, so it frees the class total", async () => {
      const t1 = tpay(usdx, "1");
      expect(await sign(t1)).toBeNull();
      for (let i = 0; i < 4; i++) expect(await sign(tpay(usdc, "1"))).toBeNull();
      expect(await sign(tpay(usdc, "1"))).toMatchObject({ status: 403 });
      await releaseCustodyDay({ flags: main, userId: 1, tx: t1 });
      expect((await tokenRows()).find((r) => r.detail.released)!.detail.cls).toBe("usd");
      expect(await sign(tpay(usdc, "1"))).toBeNull();
    });
    it("counts a path payment against its source asset, not its destination", async () => {
      const send = (amt: string) => build(Operation.pathPaymentStrictSend({ sendAsset: usdc, sendAmount: amt, destination: other, destAsset: Asset.native(), destMin: "0.1" }));
      const recv = (amt: string) => build(Operation.pathPaymentStrictReceive({ sendAsset: usdc, sendMax: amt, destination: other, destAsset: Asset.native(), destAmount: "0.1" }));
      for (let i = 0; i < 2; i++) { expect(await sign(send("1"))).toBeNull(); expect(await sign(recv("1"))).toBeNull(); }
      expect(await sign(send("1"))).toBeNull();
      expect(await sign(recv("1"))).toMatchObject({ status: 403, error: expect.stringMatching(/daily limit/) });
      // Spending XLM to receive USDC counts XLM only.
      expect(await sign(build(Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: "1", destination: other, destAsset: usdc, destMin: "0.1" })))).toBeNull();
      expect((await tokenRows()).every((r) => r.detail.asset === `USDC:${circle}`)).toBe(true);
    });
    it("gives the token usage back (once) on a definite rejection", async () => {
      const t1 = tpay(usdc, "1");
      for (let i = 0; i < 4; i++) expect(await sign(tpay(usdc, "1"))).toBeNull();
      expect(await sign(t1)).toBeNull();
      expect(await sign(tpay(usdc, "1"))).toMatchObject({ status: 403 });
      await releaseCustodyDay({ flags: main, userId: 1, tx: t1 });
      expect(await sign(tpay(usdc, "1"))).toBeNull();
      expect(await sign(tpay(usdc, "1"))).toMatchObject({ status: 403 });
      const rows = await tokenRows();
      expect(rows.filter((r) => r.detail.released === true)).toHaveLength(1);
      expect(rows.some((r) => r.detail.units === "-10000000")).toBe(true);
    });
    it("reserves nothing for tokens or XLM when signing is refused after the checks (frozen)", async () => {
      state.frozen = true;
      const t = tpay(usdc, "1");
      expect(await sign(t)).toMatchObject({ status: 423 });
      expect(t.signatures).toHaveLength(0);
      expect(await tokenRows()).toHaveLength(0);
      expect((await audits()).filter((a) => a.action === "custody_stellar_sign")).toHaveLength(0);
    });
    it("a token cap refusal does not leave an XLM reservation behind", async () => {
      for (let i = 0; i < 5; i++) expect(await sign(tpay(usdc, "1"))).toBeNull();
      const xlmRows = async () => (await audits()).filter((a) => a.action === "custody_stellar_sign").length;
      const before = await xlmRows();
      expect(await sign(tpay(usdc, "1"))).toMatchObject({ status: 403 });
      expect(await xlmRows()).toBe(before);
    });
  });

  describe("reservation only when signing happens", () => {
    const day = custodyLimitsFromEnv({ ...MAIN_ENV, CUSTODY_LIMIT_XLM_TX_STROOPS: "300000000", CUSTODY_LIMIT_XLM_DAY_STROOPS: "600000000" });
    const sign = (tx: any) => signWithCustody({ provider, flags: main, userId: 1, walletAddress: mine.stellar.publicKey, tx, limits: day });
    beforeEach(async () => { await seedPhrase(); await seedWallet("stellar", "public", mine.stellar.publicKey); });
    it("does not use any of the daily cap when signing is refused after the checks (frozen, self-signing, address mismatch)", async () => {
      const reserved = async () => (await audits()).filter((a) => a.action === "custody_stellar_sign").length;
      state.frozen = true;
      expect(await sign(pay("1"))).toMatchObject({ status: 423 });
      state.frozen = false;
      await pg.exec("UPDATE users SET signing_mode = 'self' WHERE id = 1");
      expect(await sign(pay("1"))).toMatchObject({ status: 403 });
      await pg.exec("UPDATE users SET signing_mode = 'delegated' WHERE id = 1");
      const stranger = Keypair.random().publicKey();
      await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'stellar','public',$1,'w',false,1)", [stranger]);
      const strangerTx = new TransactionBuilder(new Account(stranger, "1"), { fee: "100", networkPassphrase: Networks.PUBLIC })
        .addOperation(Operation.payment({ destination: other, asset: Asset.native(), amount: "1" })).setTimeout(60).build();
      expect(await signWithCustody({ provider, flags: main, userId: 1, walletAddress: stranger, tx: strangerTx, limits: day })).toMatchObject({ status: 409 });
      expect(strangerTx.signatures).toHaveLength(0);
      expect(await reserved()).toBe(0);
      expect(await sign(pay("29"))).toBeNull();
      expect(await sign(pay("29"))).toBeNull();
    });
  });

  describe("daily cap on server-signed XLM", () => {
    const day = custodyLimitsFromEnv({ ...MAIN_ENV, CUSTODY_LIMIT_XLM_TX_STROOPS: "300000000", CUSTODY_LIMIT_XLM_DAY_STROOPS: "600000000" });
    const sign = (tx: any, limits = day) => signWithCustody({ provider, flags: main, userId: 1, walletAddress: mine.stellar.publicKey, tx, limits });
    beforeEach(async () => { await seedPhrase(); await seedWallet("stellar", "public", mine.stellar.publicKey); });

    it("defaults to 50 XLM a day on mainnet, overridable from env, and absent on testnet", () => {
      expect(custodyLimitsFromEnv(MAIN_ENV).xlmDayStroops).toBe(500_000_000n);
      expect(custodyLimitsFromEnv({ ...MAIN_ENV, CUSTODY_LIMIT_XLM_DAY_STROOPS: "7" }).xlmDayStroops).toBe(7n);
      expect(() => custodyLimitsFromEnv({ ...MAIN_ENV, CUSTODY_LIMIT_XLM_DAY_STROOPS: "x" })).toThrow(/CUSTODY_LIMIT_XLM_DAY_STROOPS/);
      expect(custodyLimitsFromEnv({}).xlmDayStroops).toBeUndefined();
    });
    it("signs until the day's total (amounts plus fees) would pass the cap, then refuses without signing", async () => {
      const t1 = pay("29"), t2 = pay("29"), t3 = pay("2");
      expect(await sign(t1)).toBeNull(); expect(t1.signatures).toHaveLength(1);
      expect(await sign(t2)).toBeNull();
      const refused = await sign(t3);
      expect(refused).toMatchObject({ status: 403, error: expect.stringMatching(/daily limit/) });
      expect(t3.signatures).toHaveLength(0);
      // A refused attempt is not recorded; a smaller one still fits.
      expect(await sign(pay("1"))).toBeNull();
    });
    it("checks the final transaction that is signed (with fee operations added), not only the client's", async () => {
      const mk = (a: string, b: string) => new TransactionBuilder(new Account(mine.stellar.publicKey, "1"), { fee: "100", networkPassphrase: Networks.PUBLIC })
        .addOperation(Operation.payment({ destination: other, asset: Asset.native(), amount: a }))
        .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: b })).setTimeout(60).build();
      const tight = custodyLimitsFromEnv({ ...MAIN_ENV, CUSTODY_LIMIT_XLM_TX_STROOPS: "100000000", CUSTODY_LIMIT_XLM_DAY_STROOPS: "79999999" });
      const final = mk("4", "4");
      expect(await sign(final, tight)).toMatchObject({ status: 403, error: expect.stringMatching(/daily limit/) });
      expect(final.signatures).toHaveLength(0);
      // The rebuilt transaction (client payment plus a platform fee payment) is held to the per-transaction cap too.
      const perTx = custodyLimitsFromEnv({ ...MAIN_ENV, CUSTODY_LIMIT_XLM_TX_STROOPS: "100000000" });
      expect(await sign(mk("9.9", "0.2"), perTx)).toMatchObject({ status: 403, error: expect.stringMatching(/limit for one payment/) });
      expect(await sign(mk("4", "4"), perTx)).toBeNull();
    });
    it("applies the allow-list again at signing time, to what is actually signed", async () => {
      const tx = build(refusedOps.setOptions);
      expect(await sign(tx)).toMatchObject({ status: 403 });
      expect(tx.signatures).toHaveLength(0);
    });
    it("counts createAccount (starting balance) against the cap and signs it", async () => {
      const create = (xlm: string) => build(Operation.createAccount({ destination: Keypair.random().publicKey(), startingBalance: xlm }));
      const c1 = create("29");
      expect(await sign(c1)).toBeNull(); expect(c1.signatures).toHaveLength(1);
      expect(await sign(create("29"))).toBeNull();
      expect(await sign(pay("2"))).toMatchObject({ status: 403, error: expect.stringMatching(/daily limit/) });
    });
    it("leaves the day's usage unchanged when the signing step refuses (frozen account), because nothing was signed", async () => {
      state.frozen = true;
      const refused = pay("29");
      expect(await sign(refused)).toMatchObject({ status: 423 });
      expect(refused.signatures).toHaveLength(0);
      state.frozen = false;
      expect(await sign(pay("29"))).toBeNull();
      expect(await sign(pay("29"))).toBeNull();
    });
    it("gives the reservation back when Horizon definitely rejected the transaction, and keeps the audit rows", async () => {
      const t1 = pay("29"), t2 = pay("29");
      expect(await sign(t1)).toBeNull(); expect(await sign(t2)).toBeNull();
      expect(await sign(pay("2"))).toMatchObject({ status: 403 });
      await releaseCustodyDay({ flags: main, userId: 1, tx: t1 });
      expect(await sign(pay("2"))).toBeNull();
      const rows = (await audits()).filter((a) => a.action === "custody_stellar_sign");
      expect(rows.some((r) => r.detail.released === true && r.detail.stroops.startsWith("-"))).toBe(true);
      expect(rows.length).toBeGreaterThanOrEqual(4);
    });
    it("offsets the reservation it releases exactly in the 24-hour window (same timestamp), so nothing else is under-counted at the edge", async () => {
      const t1 = pay("29"), t2 = pay("29");
      expect(await sign(t1)).toBeNull();
      await pg.exec("UPDATE audit_logs SET created_at = now() - interval '23 hours 59 minutes' WHERE action = 'custody_stellar_sign'");
      expect(await sign(t2)).toBeNull();
      await releaseCustodyDay({ flags: main, userId: 1, tx: t1 });
      // The reservation and its release leave the window together; t2's 29 XLM alone remains.
      await pg.exec("UPDATE audit_logs SET created_at = created_at - interval '2 minutes' WHERE action = 'custody_stellar_sign' AND (detail->>'stroops' LIKE '-%' OR id = (SELECT min(id) FROM audit_logs WHERE action = 'custody_stellar_sign'))");
      expect(await sign(pay("29"))).toBeNull();
      expect(await sign(pay("29"))).toMatchObject({ status: 403, error: expect.stringMatching(/daily limit/) });
    });
    it("releases each reservation once", async () => {
      const t1 = pay("29");
      expect(await sign(t1)).toBeNull();
      await releaseCustodyDay({ flags: main, userId: 1, tx: t1 });
      await releaseCustodyDay({ flags: main, userId: 1, tx: t1 });
      expect(await sign(pay("29"))).toBeNull(); expect(await sign(pay("29"))).toBeNull();
      expect(await sign(pay("29"))).toMatchObject({ status: 403 });
    });
    it("releases nothing outside mainnet custody", async () => {
      const before = (await audits()).length;
      await releaseCustodyDay({ flags: test, userId: 1, tx: pay("1") });
      expect((await audits()).length).toBe(before);
    });
    it("does not count usage older than 24 hours", async () => {
      expect(await sign(pay("29"))).toBeNull(); expect(await sign(pay("29"))).toBeNull();
      await pg.exec("UPDATE audit_logs SET created_at = now() - interval '25 hours' WHERE action = 'custody_stellar_sign'");
      expect(await sign(pay("29"))).toBeNull();
    });
  });
});
