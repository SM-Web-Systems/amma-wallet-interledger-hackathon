import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { Account, BASE_FEE, Asset, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { Wallet, decode, deriveAddress } from "xrpl";
import { keccak256, recoverTransactionAddress } from "viem";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyPaymentStorage } from "../db/migrations/xrpl-payments";
import { applyReconciliationStorage } from "../db/migrations/xrpl-reconciliation";
import { applyIntegrationStorage } from "../db/migrations/xrpl-integration";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { applyCustodyV3 } from "../db/migrations/custody-v3";
import { applyCustodyV4 } from "../db/migrations/custody-v4";
import { LocalMasterKeyProvider, openFromEscrow, sealForEscrow } from "../lib/key-wrapper";
import { custodyLimitsFromEnv } from "../lib/custody-limits";
import { setAppLogger } from "../lib/app-log";
import { deriveAllChains } from "../lib/one-phrase";
import type { CustodyFlags } from "../lib/custody-flags";
import type { AccountSnapshot } from "../modules/xrpl/read-adapter";

// Moving device-only wallets into Amma's escrow (testnet), and signing for them afterwards.
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y", JWT_EXPIRES_IN: 900, XRPL: { enabled: true }, XRPL_PAYMENTS_ENABLED: true } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { custodyRoutes } from "./custody";
import { custodySendRoutes } from "./custody-send";
import { custodyEvmSendRoutes, type EvmClient } from "./custody-evm-send";
import { custodySignStellar } from "../lib/custody-sign";

const PASSWORD = "correct horse battery staple";
const ACCOUNT_PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const DEVICE_PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const OTHER_PHRASE = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";
const device = deriveAllChains(DEVICE_PHRASE);
const xrpWallet = Wallet.generate();
const stellarKey = Keypair.random();
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const on: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50 };
const off: CustodyFlags = { ...on, serverSigning: false };
const HMAC = Buffer.alloc(32, 9);
const WORDS = /\b([a-z]{3,8} ){11}[a-z]{3,8}\b/;
const dest = Wallet.generate().classicAddress;
const EVM_DEST = "0x1111111111111111111111111111111111111111";

const ledger = () => ({ chain: "xrpl" as const, network: "testnet" as const, endpoint: "wss://testnet.xrpl-labs.com/", validatedLedgerIndex: 1234, validatedLedgerHash: "A".repeat(64), observedAt: new Date().toISOString() });
const account = (address: string): AccountSnapshot => ({ ...ledger(), address, funded: true, balanceDrops: "2000000000", reserveDrops: "1000000", spendableDrops: "1900000000", sequence: 12, ownerCount: 0, requiresDestinationTag: false });
const submitted: string[] = [];
const network = {
  getAccount: vi.fn(async (a: string) => account(a)),
  getFee: vi.fn(async () => ({ ...ledger(), feeDrops: "12", currentLedgerIndex: 1235 })),
  getHealth: vi.fn(async () => ({ ...ledger(), status: "healthy" as const })),
  submitSigned: vi.fn(async (blob: string) => { submitted.push(blob); return { provisionalResult: "tesSUCCESS" }; }),
  lookupTransaction: vi.fn(async (hash: string) => ({ ...ledger(), status: "pending" as const, transactionHash: hash, validated: false, authoritative: false })),
  inspectAttempt: vi.fn(async (input: any) => ({ ...ledger(), minLedger: input.minLedger, maxLedger: input.lastLedgerSequence, anchorHash: input.anchorHash, status: "open" as const, code: "AWAITING_LEDGER_BOUND" })),
};
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
let pg: PGlite, app: FastifyInstance, gated: FastifyInstance;
const count = async (t: string) => ((await pg.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as { n: number }).n;
const audits = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];
const doImport = (over: Record<string, unknown> = {}, a = app) => a.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE, password: PASSWORD, ...over } });
const list = () => app.inject({ method: "GET", url: "/api/v1/custody/wallets" });
const escrowKinds = async () => (await pg.query("SELECT kind, origin FROM wallet_key_escrow ORDER BY kind")).rows as { kind: string; origin: string }[];
const everything = async () => JSON.stringify(await audits()) + logs.join("");

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4]) await apply(conn);
  for (const apply of [applyPaymentStorage, applyReconciliationStorage, applyIntegrationStorage]) {
    await pg.transaction(tx => apply({ execute: async (s: string) => { await tx.exec(s); }, rows: async <T extends Record<string, unknown>>(s: string) => (await tx.query<T>(s)).rows }));
  }
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  await pg.query("UPDATE users SET password_hash = $1 WHERE id IN (1,2)", [await bcrypt.hash(PASSWORD, 4)]);
  setAppLogger({ info: (o, m) => logs.push(JSON.stringify({ o, m })), warn: (o, m) => logs.push(JSON.stringify({ o, m })), error: (o, m) => logs.push(JSON.stringify({ o, m })) });
  app = Fastify();
  await app.register(custodyRoutes, { provider, flags: on });
  await app.register(custodySendRoutes, { provider, flags: on, limits: () => custodyLimitsFromEnv({}), network, submissionGate: () => {}, hmacKey: HMAC });
  await app.register(custodyEvmSendRoutes, { provider, flags: on, limits: () => custodyLimitsFromEnv({}), client: () => client });
  await app.ready();
  gated = Fastify(); await gated.register(custodyRoutes, { provider, flags: off }); await gated.ready();
}, 90000);
beforeEach(async () => {
  state.userId = 1; state.frozen = false; logs.length = 0; submitted.length = 0;
  vi.clearAllMocks();
  await pg.exec("TRUNCATE xrpl_receipt_claims,xrpl_payment_events,xrpl_payments RESTART IDENTITY CASCADE; TRUNCATE custody_evm_transfers RESTART IDENTITY; TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
});
afterAll(async () => { await app?.close(); await gated?.close(); await pg?.close(); });

describe("POST /api/v1/custody/import", () => {
  const kinds: [string, Record<string, unknown>, string][] = [
    ["an Ethereum recovery phrase", { chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE }, `import:evm:${device.evm.address.toLowerCase()}`],
    ["an XRP recovery phrase", { chain: "xrpl", address: device.xrpl.address, secret: DEVICE_PHRASE }, `import:xrpl:${device.xrpl.address}`],
    ["an XRP family seed", { chain: "xrpl", address: xrpWallet.classicAddress, secret: xrpWallet.seed! }, `import:xrpl:${xrpWallet.classicAddress}`],
    ["a Stellar recovery phrase", { chain: "stellar", address: device.stellar.publicKey, secret: DEVICE_PHRASE }, `import:stellar:${device.stellar.publicKey}`],
    ["a Stellar S... secret", { chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() }, `import:stellar:${stellarKey.publicKey()}`],
  ];
  for (const [label, body, kind] of kinds) {
    it(`accepts ${label}: seals it as ${kind.split(":").slice(0, 2).join(":")}, adds an inactive wallet row and lists it`, async () => {
      const res = await doImport({ ...body, name: "From my browser" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ imported: true, verified: true, wallet: { chain: body.chain, address: body.address, name: "From my browser", index: null, active: false, imported: true } });
      expect(await escrowKinds()).toEqual([{ kind, origin: "import" }]);
      const [e] = (await pg.query("SELECT sealed FROM wallet_key_escrow")).rows as { sealed: string }[];
      expect(await openFromEscrow(provider, e.sealed, { userId: 1, kind: kind as any, reason: "test" })).toContain(String(body.secret).split(" ")[0]);
      const [w] = (await pg.query("SELECT derivation_index, is_active, encrypted_secret FROM user_wallets")).rows as any[];
      expect(w).toEqual({ derivation_index: null, is_active: false, encrypted_secret: null });
      const a = await audits();
      expect(a.filter((x) => x.action === "custody_wallet_imported")).toHaveLength(1);
      expect(res.body + await everything()).not.toContain(String(body.secret));
      expect(res.body + await everything()).not.toMatch(WORDS);
      const l = await list();
      expect(l.statusCode).toBe(200);
      expect(l.json().wallets).toEqual([{ chain: body.chain, network: body.chain === "evm" ? "sepolia" : "testnet", address: body.address, name: "From my browser", index: null, active: false, imported: true }]);
    });
  }

  it("sealed text is bound to its kind: another wallet's kind cannot open it", async () => {
    await doImport();
    const [e] = (await pg.query("SELECT sealed FROM wallet_key_escrow")).rows as { sealed: string }[];
    await expect(openFromEscrow(provider, e.sealed, { userId: 1, kind: `import:evm:0x${"1".repeat(40)}`, reason: "test" })).rejects.toThrow();
    await expect(openFromEscrow(provider, e.sealed, { userId: 2, kind: `import:evm:${device.evm.address.toLowerCase()}`, reason: "test" })).rejects.toThrow();
  });

  it("returns 400 when the secret does not derive the address, and stores nothing or echoes any part of it", async () => {
    const other = deriveAllChains(OTHER_PHRASE);
    for (const body of [
      { chain: "evm", address: other.evm.address },
      { chain: "xrpl", address: other.xrpl.address },
      { chain: "stellar", address: other.stellar.publicKey },
      { chain: "xrpl", address: dest, secret: xrpWallet.seed! },
      { chain: "stellar", address: Keypair.random().publicKey(), secret: stellarKey.secret() },
    ]) {
      const res = await doImport(body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("That phrase doesn't match this wallet.");
      expect(res.body).not.toContain(DEVICE_PHRASE.split(" ")[0] + " ");
    }
    expect(await count("wallet_key_escrow")).toBe(0);
    expect(await count("user_wallets")).toBe(0);
    expect(await everything()).not.toMatch(WORDS);
  });

  it("rejects secrets that are not usable, wrong chains of secret, and bad input without storing anything", async () => {
    for (const body of [
      { secret: "not a phrase at all really not a phrase at all really" },
      { chain: "evm", address: device.evm.address, secret: xrpWallet.seed! },
      { chain: "evm", secret: DEVICE_PHRASE, address: "0x123" },
      { chain: "bitcoin" }, { secret: "" }, { password: "" }, { extra: 1 }, { name: "x".repeat(41) },
    ]) expect((await doImport(body)).statusCode).toBe(400);
    expect(await count("wallet_key_escrow")).toBe(0);
  });

  it("refuses a wrong password with 403 and stores nothing", async () => {
    const res = await doImport({ password: "nope" });
    expect(res.statusCode).toBe(403);
    expect(await count("wallet_key_escrow")).toBe(0);
    expect(await count("user_wallets")).toBe(0);
    expect((await audits()).map((a) => a.action)).toEqual(["wallet_custody_sign_denied"]);
    expect(res.body + await everything()).not.toContain("nope");
  });

  it("refuses an address that belongs to another account's wallet or import", async () => {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (2,'evm','sepolia',$1,'theirs',true,0)", [device.evm.address]);
    const res = await doImport();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/another account/);
    expect(await count("wallet_key_escrow")).toBe(0);
    // Another user's import escrow alone also blocks it.
    await pg.exec("DELETE FROM user_wallets");
    state.userId = 2; expect((await doImport()).statusCode).toBe(200);
    state.userId = 1; expect((await doImport()).statusCode).toBe(409);
    expect(await count("wallet_key_escrow")).toBe(1);
  });

  it("is idempotent: the same wallet twice leaves one escrow row, one wallet row and one audit", async () => {
    expect((await doImport()).json().imported).toBe(true);
    const again = await doImport({ address: device.evm.address.toLowerCase(), name: "Other name" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ imported: false, alreadyHeld: true, verified: true, wallet: { name: "Imported Ethereum", index: null } });
    expect(await count("wallet_key_escrow")).toBe(1);
    expect(await count("user_wallets")).toBe(1);
    expect((await audits()).filter((a) => a.action === "custody_wallet_imported")).toHaveLength(1);
  });

  it("keeps an existing wallet row (a Stellar address the app already knows), and does not touch a derived wallet", async () => {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'stellar','testnet',$1,'Mine',true)", [stellarKey.publicKey()]);
    const res = await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() });
    expect(res.json().wallet).toMatchObject({ name: "Mine", active: true, imported: true });
    expect(await count("user_wallets")).toBe(1);
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'xrpl','testnet',$1,'Derived',true,0)", [device.xrpl.address]);
    await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,$1,$2,$3,$4)", ["phrase", await sealForEscrow(provider, DEVICE_PHRASE, { userId: 1, kind: "phrase" }), "local", "custody"]);
    const derived = await doImport({ chain: "xrpl", address: device.xrpl.address });
    expect(derived.json()).toMatchObject({ imported: false, alreadyHeld: true, wallet: { index: 0 } });
    expect((await escrowKinds()).map((k) => k.kind).filter((k) => k !== "phrase")).toEqual([`import:stellar:${stellarKey.publicKey()}`]);
  });

  it("is off with the flag (503), refused for self-custody accounts (409), and works without an account phrase", async () => {
    expect((await doImport({}, gated)).statusCode).toBe(503);
    await pg.exec("UPDATE users SET signing_mode='self'");
    expect((await doImport()).statusCode).toBe(409);
    expect(await count("wallet_key_escrow")).toBe(0);
  });

  it("retiring a legacy PIN wallet moves a self-custody account's wallet and switches the account to managed signing, after verification", async () => {
    await pg.exec("UPDATE users SET signing_mode='self'");
    expect((await doImport({ retirePin: "yes" })).statusCode).toBe(400);
    const res = await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret(), retirePin: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ imported: true, verified: true });
    expect((await pg.query("SELECT signing_mode FROM users WHERE id = 1")).rows).toEqual([{ signing_mode: "delegated" }]);
    expect((await audits()).filter((a) => a.action === "custody_pin_copy_removed").map((a) => a.detail.signingModeChanged)).toEqual(["self->delegated"]);
  });

  it("a self-custody account stays self-custody when the move can't be verified", async () => {
    await pg.exec("UPDATE users SET signing_mode='delegated'");
    await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() });
    await pg.exec("UPDATE users SET signing_mode='self'");
    await pg.query("UPDATE wallet_key_escrow SET sealed = $1", ["v1.local." + "A".repeat(60) + ".AAAA.BBBB"]);
    const res = await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret(), retirePin: true });
    expect(res.statusCode).toBe(500);
    expect((await pg.query("SELECT signing_mode FROM users WHERE id = 1")).rows).toEqual([{ signing_mode: "self" }]);
  });

  it("lists imported wallets next to derived ones, with imported only on the moved ones", async () => {
    await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", [await sealForEscrow(provider, ACCOUNT_PHRASE, { userId: 1, kind: "phrase" })]);
    const mine = deriveAllChains(ACCOUNT_PHRASE);
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'evm','sepolia',$1,'Amma Ethereum',true,0)", [mine.evm.address]);
    await doImport({ name: "Old" });
    // A row with no index and no escrow (a plain device wallet row) is not shown.
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'xrpl','testnet',$1,'device',false)", [dest]);
    const wallets = (await list()).json().wallets;
    expect(wallets.map((w: any) => [w.name, w.index, w.imported])).toEqual([["Amma Ethereum", 0, undefined], ["Old", null, true]]);
  });

  it("an account with neither a phrase nor an import is told Amma holds nothing (409)", async () => {
    expect((await list()).statusCode).toBe(409);
  });
});

describe("signing for imported wallets", () => {
  const importedFor = async (body: Record<string, unknown>) => { expect((await doImport(body)).statusCode).toBe(200); };

  it("XRP send: signs with the imported family seed's key", async () => {
    await importedFor({ chain: "xrpl", address: xrpWallet.classicAddress, secret: xrpWallet.seed! });
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/xrpl/send", payload: { from: xrpWallet.classicAddress, to: dest, amountDrops: "5000000", password: PASSWORD, idempotencyKey: randomUUID() } });
    expect([200, 202]).toContain(res.statusCode);
    expect(submitted).toHaveLength(1);
    const tx = decode(submitted[0]) as any;
    expect(deriveAddress(tx.SigningPubKey)).toBe(xrpWallet.classicAddress);
    expect(tx).toMatchObject({ Account: xrpWallet.classicAddress, Destination: dest, Amount: "5000000" });
    expect((await audits()).map((a) => a.action)).toEqual(["custody_wallet_imported", "wallet_key_escrow_open", "wallet_custody_sign", "wallet_key_escrow_open", "wallet_custody_sign", "custody_send"]);
    expect((await audits()).filter((a) => a.action === "wallet_key_escrow_open").pop()!.detail).toMatchObject({ kind: `import:xrpl:${xrpWallet.classicAddress}`, reason: "custody-sign:xrpl:import" });
    expect(res.body + await everything()).not.toContain(xrpWallet.seed!);
  });

  it("XRP send: signs with the key from an imported recovery phrase", async () => {
    await importedFor({ chain: "xrpl", address: device.xrpl.address, secret: DEVICE_PHRASE });
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/xrpl/send", payload: { from: device.xrpl.address, to: dest, amountDrops: "5000000", password: PASSWORD, idempotencyKey: randomUUID() } });
    expect([200, 202]).toContain(res.statusCode);
    expect(deriveAddress((decode(submitted[0]) as any).SigningPubKey)).toBe(device.xrpl.address);
  });

  it("ETH send: signs the Sepolia transaction with the imported phrase's key (a wallet with no server row before)", async () => {
    await importedFor({ chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE });
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/evm/send", payload: { from: device.evm.address, to: EVM_DEST, amountWei: String(5n * 10n ** 15n), password: PASSWORD, idempotencyKey: `idem-key-${Date.now()}` } });
    expect(res.statusCode).toBe(200);
    const raw = client.sendRawTransaction.mock.calls[0][0];
    expect((await recoverTransactionAddress({ serializedTransaction: raw as any })).toLowerCase()).toBe(device.evm.address.toLowerCase());
    expect((await audits()).map((a) => a.action)).toEqual(["custody_wallet_imported", "wallet_key_escrow_open", "wallet_custody_sign", "wallet_key_escrow_open", "wallet_custody_sign", "custody_send"]);
    expect(res.body + await everything()).not.toMatch(WORDS);
  });

  const stellarTx = (source: string) => TransactionBuilder.fromXDR(
    new TransactionBuilder(new Account(source, "1"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" })).setTimeout(60).build().toXDR(),
    Networks.TESTNET) as any;

  it("Stellar sign: signs with the imported S... secret and with an imported phrase", async () => {
    for (const [address, secret, pair] of [[stellarKey.publicKey(), stellarKey.secret(), stellarKey], [device.stellar.publicKey, DEVICE_PHRASE, Keypair.fromPublicKey(device.stellar.publicKey)]] as const) {
      await importedFor({ chain: "stellar", address, secret });
      const tx = stellarTx(address);
      expect(await custodySignStellar({ provider, flags: on, userId: 1, password: PASSWORD, walletAddress: address, tx })).toBeNull();
      expect(tx.signatures).toHaveLength(1);
      expect(pair.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    }
    expect(await everything()).not.toContain(stellarKey.secret());
  });

  it("refuses a send from a wallet row with no import escrow (403) and signs nothing", async () => {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'evm','sepolia',$1,'device',false)", [device.evm.address]);
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/evm/send", payload: { from: device.evm.address, to: EVM_DEST, amountWei: "1000", password: PASSWORD, idempotencyKey: `idem-key-${Date.now()}` } });
    expect(res.statusCode).toBe(403);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
    expect((await audits()).map((a) => a.action)).toEqual([]);
  });

  it("still refuses when the account is frozen, and another user's import cannot be used", async () => {
    await importedFor({ chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE });
    const send = () => app.inject({ method: "POST", url: "/api/v1/custody/evm/send", payload: { from: device.evm.address, to: EVM_DEST, amountWei: "1000", password: PASSWORD, idempotencyKey: `idem-${randomUUID()}` } });
    state.frozen = true; expect((await send()).statusCode).toBe(423);
    state.frozen = false; state.userId = 2; expect((await send()).statusCode).toBe(403);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });
});

const patch = (body: any) => app.inject({ method: "PATCH", url: "/api/v1/custody/wallets", payload: body });
const seedImports = async (chain: "xrpl" | "evm", n: number) => {
  for (let i = 0; i < n; i++) {
    const address = chain === "xrpl" ? Wallet.generate().classicAddress : "0x" + (i + 1).toString(16).padStart(40, "0");
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,$1,$2,$3,'seed',false)", [chain, chain === "evm" ? "sepolia" : "testnet", address]);
    await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,$1,$2,'local','import')", [`import:${chain}:${chain === "evm" ? address : address}`, "x".repeat(60)]);
  }
};

describe("import review fixes", () => {
  it("rate-limits per signed-in user, not per address", async () => {
    const { default: rateLimit } = await import("@fastify/rate-limit");
    const { generateAccessToken } = await import("../lib/auth");
    const limited = Fastify();
    await limited.register(rateLimit, { global: false });
    await limited.register(custodyRoutes, { provider, flags: on });
    await limited.ready();
    const as = (id: number) => limited.inject({ method: "POST", url: "/api/v1/custody/import", headers: { authorization: `Bearer ${generateAccessToken({ userId: id, type: "user" } as any)}` }, payload: { chain: "bitcoin" } });
    for (let i = 0; i < 10; i++) expect((await as(1)).statusCode).toBe(400);
    expect((await as(1)).statusCode).toBe(429);
    expect((await as(2)).statusCode).toBe(400);
    await limited.close();
  });

  it("caps imported wallets at 10 per network", async () => {
    await seedImports("xrpl", 10);
    const res = await doImport({ chain: "xrpl", address: device.xrpl.address });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("You can move up to 10 wallets per network.");
    expect(await count("wallet_key_escrow")).toBe(10);
    await seedImports("evm", 1);
    expect((await doImport()).statusCode).toBe(200);
  });

  it("refuses while a recovery freeze is active (423) and stores nothing", async () => {
    state.frozen = true;
    expect((await doImport()).statusCode).toBe(423);
    expect(await count("wallet_key_escrow")).toBe(0);
  });

  it("refuses an address on another account's wallet on any network, or on this account's mainnet row", async () => {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (2,'xrpl','mainnet',$1,'theirs',false)", [device.xrpl.address]);
    expect((await doImport({ chain: "xrpl", address: device.xrpl.address })).statusCode).toBe(409);
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'stellar','public',$1,'mine main',false)", [stellarKey.publicKey()]);
    const res = await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() });
    expect(res.statusCode).toBe(409);
    expect(await count("wallet_key_escrow")).toBe(0);
  });

  it("lets imported wallets be renamed and made main, including Stellar", async () => {
    await doImport({ chain: "evm", address: device.evm.address, name: "Old" });
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'evm','sepolia',$1,'Other',true)", ["0x" + "9".repeat(40)]);
    const r = await patch({ chain: "evm", address: device.evm.address.toLowerCase(), name: "Renamed", active: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().wallet).toMatchObject({ name: "Renamed", active: true, index: null, imported: true });
    expect((await pg.query("SELECT name FROM user_wallets WHERE is_active AND chain='evm'")).rows).toEqual([{ name: "Renamed" }]);
    expect((await audits()).find((a) => a.action === "custody_wallet_updated")!.detail).toEqual({ chain: "evm", index: null, renamed: true, active: true });
    // A plain row with no import escrow is still not yours to manage here.
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'xrpl','testnet',$1,'device',false)", [dest]);
    expect((await patch({ chain: "xrpl", address: dest, name: "x" })).statusCode).toBe(404);
  });

  it("an imported Stellar wallet made main signs through the active-wallet lookup the sign route uses", async () => {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,'stellar','testnet',$1,'Other',true)", [Keypair.random().publicKey()]);
    expect((await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() })).statusCode).toBe(200);
    expect((await patch({ chain: "stellar", address: stellarKey.publicKey(), active: true })).statusCode).toBe(200);
    const { findActiveStellarWallet } = await import("../services/stellar-wallet.service");
    const active = await findActiveStellarWallet(1);
    expect(active!.publicKey).toBe(stellarKey.publicKey());
    const tx = TransactionBuilder.fromXDR(new TransactionBuilder(new Account(active!.publicKey, "1"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" })).setTimeout(60).build().toXDR(), Networks.TESTNET) as any;
    expect(await custodySignStellar({ provider, flags: on, userId: 1, password: PASSWORD, walletAddress: active!.publicKey, tx })).toBeNull();
    expect(stellarKey.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
  });
});

describe("import verifies the stored wallet can sign", () => {
  for (const [label, body] of [
    ["evm", { chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE }],
    ["xrpl seed", { chain: "xrpl", address: xrpWallet.classicAddress, secret: xrpWallet.seed! }],
    ["xrpl phrase", { chain: "xrpl", address: device.xrpl.address, secret: DEVICE_PHRASE }],
    ["stellar secret", { chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() }],
    ["stellar phrase", { chain: "stellar", address: device.stellar.publicKey, secret: DEVICE_PHRASE }],
  ] as [string, Record<string, unknown>][]) {
    it(`returns verified true on a new import and again on alreadyHeld (${label}), through the signer path, without returning a signature`, async () => {
      const first = await doImport(body);
      expect(first.json()).toMatchObject({ imported: true, verified: true });
      const again = await doImport(body);
      expect(again.json()).toMatchObject({ imported: false, alreadyHeld: true, verified: true });
      const a = await audits();
      expect(a.filter((x) => x.action === "wallet_custody_sign").map((x) => x.detail.reason)).toEqual(["custody-import-verify", "custody-import-verify"]);
      expect(Object.keys(first.json()).sort()).toEqual(["alreadyHeld", "imported", "pinCopyRemoved", "verified", "wallet"]);
      expect(first.json().pinCopyRemoved).toBe(false);
      expect(first.body + again.body + await everything()).not.toContain(String(body.secret));
    });
  }

  it("a verified move of a legacy PIN wallet deletes the server's PIN-encrypted copy and audits it, once", async () => {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, encrypted_secret) VALUES (1,'stellar','testnet',$1,'PIN wallet',true,'pin-ciphertext')", [stellarKey.publicKey()]);
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, encrypted_secret) VALUES (1,'stellar','testnet',$1,'Another',false,'other-ciphertext')", [Keypair.random().publicKey()]);
    const res = await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ verified: true, pinCopyRemoved: true });
    const rows = (await pg.query("SELECT name, encrypted_secret FROM user_wallets WHERE user_id = 1 ORDER BY id")).rows;
    expect(rows).toEqual([{ name: "PIN wallet", encrypted_secret: null }, { name: "Another", encrypted_secret: "other-ciphertext" }]);
    expect((await audits()).filter((a) => a.action === "custody_pin_copy_removed")).toEqual([{ action: "custody_pin_copy_removed", detail: { chain: "stellar", address: stellarKey.publicKey() } }]);
    const again = await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() });
    expect(again.json()).toMatchObject({ alreadyHeld: true, verified: true, pinCopyRemoved: false });
    expect((await audits()).filter((a) => a.action === "custody_pin_copy_removed")).toHaveLength(1);
  });

  it("keeps the PIN-encrypted copy when the stored wallet can't be verified", async () => {
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, encrypted_secret) VALUES (1,'stellar','testnet',$1,'PIN wallet',true,'pin-ciphertext')", [stellarKey.publicKey()]);
    await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() });
    await pg.query("UPDATE user_wallets SET encrypted_secret = 'pin-ciphertext'");
    await pg.query("UPDATE wallet_key_escrow SET sealed = $1", ["v1.local." + "A".repeat(60) + ".AAAA.BBBB"]);
    const res = await doImport({ chain: "stellar", address: stellarKey.publicKey(), secret: stellarKey.secret() });
    expect(res.statusCode).toBe(500);
    expect((await pg.query("SELECT encrypted_secret FROM user_wallets")).rows).toEqual([{ encrypted_secret: "pin-ciphertext" }]);
  });

  it("a corrupted escrow row gives 500 verified false, keeps the row and logs only a code", async () => {
    await doImport({ chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE });
    await pg.query("UPDATE wallet_key_escrow SET sealed = $1", ["v1.local." + "A".repeat(60) + ".AAAA.BBBB"]);
    logs.length = 0;
    const res = await doImport({ chain: "evm", address: device.evm.address, secret: DEVICE_PHRASE });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Amma stored the wallet but couldn't verify it yet. Keep the copy on your device.", verified: false });
    expect(await count("wallet_key_escrow")).toBe(1);
    expect(logs.join("")).toContain("custody_import_verify_failed");
    expect(res.body + logs.join("")).not.toMatch(WORDS);
  });
});
