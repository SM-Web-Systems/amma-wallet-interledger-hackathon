import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { Wallet, decode, deriveAddress } from "xrpl";
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
import { applyXrplMainnet } from "../db/migrations/xrpl-mainnet";
import { LocalMasterKeyProvider, sealForEscrow } from "../lib/key-wrapper";
import { custodyLimitsFromEnv } from "../lib/custody-limits";
import { custodyXrplActivation } from "../lib/xrpl-activation";
import { deriveAllChains } from "../lib/one-phrase";
import { setAppLogger } from "../lib/app-log";
import type { CustodyFlags } from "../lib/custody-flags";
import type { AccountSnapshot } from "../modules/xrpl/read-adapter";
import { XrplPaymentService } from "../modules/xrpl/payment-service";

// XRP for Amma-held wallets on mainnet with XRPL_MAINNET_CUSTODY=on: PGlite and a mocked XRP Ledger (no network calls).
const state = vi.hoisted(() => ({ db: undefined as any, userId: 1, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "public", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y", JWT_EXPIRES_IN: 900, XRPL: { enabled: true, network: "mainnet" }, XRPL_PAYMENTS_ENABLED: true } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { custodyRoutes } from "./custody";
import { custodySendRoutes } from "./custody-send";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const DEVICE_PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PASSWORD = "correct horse battery staple";
const XRP = 1_000_000;
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const MAIN_ENV = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet", XRPL_MAINNET_CUSTODY: "on" };
const on: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50, mainnet: true, mainnetUserIds: new Set([1]), xrplMainnet: true };
const off: CustodyFlags = { ...on, xrplMainnet: undefined };
const mine = deriveAllChains(PHRASE, 0);
const device = deriveAllChains(DEVICE_PHRASE);
const dest = Wallet.generate().classicAddress;

const ledger = () => ({ chain: "xrpl" as const, network: "mainnet" as const, endpoint: "wss://xrplcluster.com/", validatedLedgerIndex: 90_000_000, validatedLedgerHash: "A".repeat(64), observedAt: new Date().toISOString() });
const funded = (address: string): AccountSnapshot => ({ ...ledger(), address, funded: true, balanceDrops: String(30 * XRP), reserveDrops: String(XRP), baseReserveDrops: String(XRP), spendableDrops: String(29 * XRP), sequence: 12, ownerCount: 0, requiresDestinationTag: false });
const unfunded = (address: string): AccountSnapshot => ({ ...ledger(), address, funded: false, balanceDrops: "0", reserveDrops: String(XRP), baseReserveDrops: String(XRP), spendableDrops: "0", sequence: null, ownerCount: 0, requiresDestinationTag: false });
const accounts = new Map<string, AccountSnapshot>();
const submitted: string[] = [];
const network = {
  xrplNetwork: "mainnet" as const,
  getAccount: vi.fn(async (a: string) => accounts.get(a) ?? funded(a)),
  getFee: vi.fn(async () => ({ ...ledger(), feeDrops: "12", currentLedgerIndex: 90_000_001 })),
  getHealth: vi.fn(async () => ({ ...ledger(), status: "healthy" as const })),
  submitSigned: vi.fn(async (blob: string) => { submitted.push(blob); return { provisionalResult: "tesSUCCESS" }; }),
  lookupTransaction: vi.fn(async (hash: string) => ({ ...ledger(), status: "pending" as const, transactionHash: hash, validated: false as const, authoritative: false as const })),
  inspectAttempt: vi.fn(async (input: any) => ({ ...ledger(), minLedger: input.minLedger, maxLedger: input.lastLedgerSequence, anchorHash: input.anchorHash, status: "open" as const, code: "AWAITING_LEDGER_BOUND" })),
};
let pg: PGlite, app: FastifyInstance, offApp: FastifyInstance;
const rows = async () => (await pg.query("SELECT chain, network, public_key, derivation_index, is_active FROM user_wallets WHERE user_id=1 ORDER BY chain, id")).rows as any[];
const audits = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];
const onboard = (a = app) => a.inject({ method: "POST", url: "/api/v1/custody/onboard" });
/** A known phrase (onboarding makes a random one) with its index-0 XRP wallet on mainnet. */
const seedHeld = async () => {
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", [await sealForEscrow(provider, PHRASE, { userId: 1, kind: "phrase" })]);
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'xrpl','mainnet',$1,'Amma XRP',true,0)", [mine.xrpl.address]);
};
const send = (over: Record<string, unknown> = {}, a = app) => a.inject({ method: "POST", url: "/api/v1/custody/xrpl/send",
  payload: { from: mine.xrpl.address, to: dest, amountDrops: String(2 * XRP), password: PASSWORD, idempotencyKey: randomUUID(), ...over } });
const account = (address: string, a = app) => a.inject({ method: "GET", url: `/api/v1/custody/xrpl/account?address=${address}` });

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4, applyCustodyV5]) await apply(conn);
  for (const apply of [applyPaymentStorage, applyReconciliationStorage, applyIntegrationStorage, applyXrplMainnet]) {
    await pg.transaction(tx => apply({ execute: async (s: string) => { await tx.exec(s); }, rows: async <T extends Record<string, unknown>>(s: string) => (await tx.query<T>(s)).rows }));
  }
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  await pg.query("UPDATE users SET password_hash = $1 WHERE id IN (1,2)", [await bcrypt.hash(PASSWORD, 4)]);
  setAppLogger({ info: () => {}, warn: () => {}, error: () => {} });
  const limits = () => custodyLimitsFromEnv(MAIN_ENV);
  app = Fastify();
  await app.register(custodyRoutes, { provider, flags: on });
  await app.register(custodySendRoutes, { provider, flags: on, limits, network, submissionGate: () => {}, hmacKey: Buffer.alloc(32, 9) });
  await app.ready();
  offApp = Fastify();
  await offApp.register(custodyRoutes, { provider, flags: off });
  await offApp.register(custodySendRoutes, { provider, flags: off, limits, network: {} as any, submissionGate: () => {}, hmacKey: Buffer.alloc(32, 9) });
  await offApp.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1; state.frozen = false; vi.clearAllMocks(); accounts.clear(); submitted.length = 0;
  await pg.exec("TRUNCATE xrpl_receipt_claims,xrpl_payment_events,xrpl_payments RESTART IDENTITY CASCADE; TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
});
afterAll(async () => { await app?.close(); await offApp?.close(); await pg?.close(); });

describe("the switch off on mainnet: today's refusals, unchanged", () => {
  it("no XRP slot at onboarding; add, import, send and the account read are refused before any key or ledger use", async () => {
    expect((await onboard(offApp)).json().wallets.xrpl).toBeUndefined();
    expect((await rows()).filter((r) => r.chain === "xrpl")).toHaveLength(0);
    const add = await offApp.inject({ method: "POST", url: "/api/v1/custody/wallets", payload: { chain: "xrpl" } });
    expect([add.statusCode, add.json().error]).toEqual([400, "XRP wallets are only available on the test network for now."]);
    const imp = await offApp.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "xrpl", address: device.xrpl.address, secret: DEVICE_PHRASE, password: PASSWORD } });
    expect(imp.statusCode).toBe(400);
    const s = await send({}, offApp);
    expect([s.statusCode, s.json().error]).toEqual([503, "XRP sending from Amma-held wallets isn't available on mainnet yet."]);
    expect((await account(mine.xrpl.address, offApp)).statusCode).toBe(503);
    expect((await audits()).map((a) => a.action)).toEqual(["custody_onboard"]);
    expect(network.getAccount).not.toHaveBeenCalled();
  });
});

describe("onboarding, add and import with XRPL_MAINNET_CUSTODY=on", () => {
  it("onboarding creates the XRP slot on xrpl/mainnet, unfunded", async () => {
    const res = await onboard();
    expect(res.json()).toMatchObject({ created: true, funding: "off" });
    const xrpl = res.json().wallets.xrpl;
    expect(xrpl).toMatch(/^r/);
    expect((await rows()).find((r) => r.chain === "xrpl")).toMatchObject({ network: "mainnet", public_key: xrpl, derivation_index: 0, is_active: true });
    expect(network.submitSigned).not.toHaveBeenCalled();
    const list = (await app.inject({ method: "GET", url: "/api/v1/custody/wallets" })).json().wallets;
    expect(list.find((w: any) => w.chain === "xrpl")).toMatchObject({ network: "mainnet", address: xrpl });
  });
  it("adds an XRP wallet on mainnet", async () => {
    await seedHeld();
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/wallets", payload: { chain: "xrpl", name: "Two" } });
    expect(res.json().wallet).toMatchObject({ chain: "xrpl", network: "mainnet", index: 1, address: deriveAllChains(PHRASE, 1).xrpl.address });
  });
  it("imports an XRP wallet on mainnet after the password check", async () => {
    await onboard();
    const bad = await app.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "xrpl", address: device.xrpl.address, secret: DEVICE_PHRASE, password: "wrong" } });
    expect(bad.statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: "/api/v1/custody/import", payload: { chain: "xrpl", address: device.xrpl.address, secret: DEVICE_PHRASE, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    expect(res.json().wallet).toMatchObject({ chain: "xrpl", network: "mainnet", imported: true });
  });
  it("keeps the allow-list: an unlisted user gets nothing", async () => {
    state.userId = 2;
    expect((await onboard()).statusCode).toBe(403);
    expect((await send({})).statusCode).toBe(403);
    expect((await account(mine.xrpl.address)).statusCode).toBe(403);
  });
});

describe("XRP send on mainnet with XRPL_MAINNET_CUSTODY=on", () => {
  beforeEach(async () => { await seedHeld(); });

  it("signs with the derived key, stores a mainnet payment and submits it, with the audit trail", async () => {
    const res = await send({ destinationTag: 9 });
    expect([200, 202]).toContain(res.statusCode);
    expect(res.json()).toMatchObject({ state: "submitted", network: "mainnet" });
    expect(submitted).toHaveLength(1);
    const tx = decode(submitted[0]) as any;
    expect(deriveAddress(tx.SigningPubKey)).toBe(mine.xrpl.address);
    expect(tx).toMatchObject({ Account: mine.xrpl.address, Destination: dest, Amount: String(2 * XRP), DestinationTag: 9 });
    expect((await pg.query("SELECT network, chain FROM xrpl_payments")).rows).toEqual([{ network: "mainnet", chain: "xrpl" }]);
    expect((await audits()).map((a) => a.action)).toEqual(["wallet_key_escrow_open", "wallet_custody_sign", "custody_send"]);
  });
  it("shows the payment's status through the custody route, only to its owner", async () => {
    const id = (await send({})).json().id;
    const res = await app.inject({ method: "GET", url: `/api/v1/custody/xrpl/payments/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, network: "mainnet", state: "submitted" });
    expect(res.json()).not.toHaveProperty("preparation");
    expect((await app.inject({ method: "GET", url: "/api/v1/custody/xrpl/payments/not-a-uuid" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/v1/custody/xrpl/payments/${randomUUID()}` })).statusCode).toBe(404);
    state.userId = 2;
    expect((await app.inject({ method: "GET", url: `/api/v1/custody/xrpl/payments/${id}` })).statusCode).toBe(403);
  });
  it("applies the mainnet limits: 5 XRP per payment", async () => {
    const res = await send({ amountDrops: String(5 * XRP + 1) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("That is more than the 5 XRP limit for one payment.");
    expect(submitted).toHaveLength(0);
  });
  it("applies the mainnet limits: 20 XRP a day", async () => {
    for (let i = 0; i < 4; i++) {
      expect((await send({ amountDrops: String(4 * XRP) })).statusCode).toBeLessThan(300);
      await pg.exec("UPDATE xrpl_payments SET state='validated_success', receipt='{}', result_code='tesSUCCESS' WHERE state='submitted'");
    }
    const res = await send({ amountDrops: String(4 * XRP) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/20 XRP daily limit/);
  });
  it("needs the password", async () => {
    expect((await send({ password: "nope" })).statusCode).toBe(403);
    expect(await pg.query("SELECT 1 FROM xrpl_payments").then((r) => r.rows.length)).toBe(0);
  });
  it("is refused while a recovery freeze is waiting", async () => {
    state.frozen = true;
    expect((await send({})).statusCode).toBe(423);
  });
  it("refuses a send that would leave the wallet below its reserve, with the amounts", async () => {
    accounts.set(mine.xrpl.address, { ...funded(mine.xrpl.address), balanceDrops: String(3 * XRP), reserveDrops: String(1.4 * XRP), spendableDrops: String(1.6 * XRP), ownerCount: 2 });
    const res = await send({ amountDrops: String(2 * XRP) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("There is not enough XRP in this wallet for that: the XRP Ledger keeps 1.4 XRP locked in it (the 1 XRP base reserve plus 0.4 XRP for the 2 items it owns). You can send up to 1.599988 XRP after the network fee.");
    expect(submitted).toHaveLength(0);
  });
  it("needs at least the base reserve for a destination that is not activated (tecNO_DST_INSUF_XRP)", async () => {
    accounts.set(dest, unfunded(dest));
    const res = await send({ amountDrops: String(XRP / 2) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("The destination account is not activated on the XRP Ledger yet, so this payment must be at least 1 XRP (the base reserve). A smaller payment would fail (tecNO_DST_INSUF_XRP).");
    expect((await send({ amountDrops: String(XRP) })).statusCode).toBeLessThan(300);
  });
  it("says plainly when the sending wallet is not activated yet", async () => {
    accounts.set(mine.xrpl.address, unfunded(mine.xrpl.address));
    const res = await send({});
    expect(res.json().error).toBe("This wallet is not activated yet. It is activated when you complete an eligible task.");
    expect(submitted).toHaveLength(0);
  });
});

describe("activation state of an Amma-held XRP wallet", () => {
  beforeEach(async () => { await seedHeld(); });
  it("the account route shows an unactivated wallet", async () => {
    accounts.set(mine.xrpl.address, unfunded(mine.xrpl.address));
    const res = await account(mine.xrpl.address);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ address: mine.xrpl.address, network: "mainnet", activated: false, balanceDrops: "0", reserveDrops: String(XRP), spendableDrops: "0", baseReserveDrops: String(XRP) });
    accounts.set(mine.xrpl.address, funded(mine.xrpl.address));
    expect((await account(mine.xrpl.address)).json()).toMatchObject({ activated: true, balanceDrops: String(30 * XRP) });
  });
  it("refuses an address that is not one of the user's Amma-held wallets, before any ledger read", async () => {
    const res = await account(device.xrpl.address);
    expect(res.statusCode).toBe(403);
    expect((await account("not-an-address")).statusCode).toBe(400);
    expect(network.getAccount).not.toHaveBeenCalled();
  });
  it("custodyXrplActivation gives the funding service the exact drops needed (base reserve + fee)", async () => {
    accounts.set(mine.xrpl.address, unfunded(mine.xrpl.address));
    expect(await custodyXrplActivation({ userId: 1, address: mine.xrpl.address, flags: on, reader: network })).toMatchObject({ ok: true, activation: { activated: false, neededDrops: String(XRP + 12), network: "mainnet" } });
    expect(await custodyXrplActivation({ userId: 2, address: mine.xrpl.address, flags: on, reader: network })).toMatchObject({ ok: false, status: 403 });
    expect(await custodyXrplActivation({ userId: 1, address: mine.xrpl.address, flags: off, reader: network })).toMatchObject({ ok: false, status: 503 });
    expect(await custodyXrplActivation({ userId: 1, address: device.xrpl.address, flags: on, reader: network })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("other XRP routes stay testnet-only on an XRPL mainnet server", () => {
  it("self-custody wallets and browser-signed payments answer 503 before any read", async () => {
    const { xrplWalletRoutes } = await import("./xrpl-wallets");
    const { xrplPaymentRoutes } = await import("./xrpl-payments");
    const other = Fastify();
    await other.register(xrplWalletRoutes, { reader: network });
    await other.register(xrplPaymentRoutes, { network, submissionGate: () => {} });
    await other.ready();
    try {
      const w = await other.inject({ method: "GET", url: "/api/v1/xrpl/wallets" });
      expect(w.statusCode).toBe(503);
      expect(w.body).toContain("XRPL_TESTNET_ONLY");
      const p = await other.inject({ method: "POST", url: "/api/v1/xrpl/payment-intents", headers: { authorization: "Bearer x" }, payload: {} });
      expect(p.statusCode).toBe(503);
      expect(p.body).toContain("XRPL_PAYMENTS_DISABLED");
      const a = await other.inject({ method: "GET", url: "/api/v1/xrpl/payment-availability", headers: { authorization: "Bearer x" } });
      expect(a.statusCode).toBe(503);
      expect(a.body).toContain("XRPL_PAYMENTS_DISABLED");
      expect(network.getAccount).not.toHaveBeenCalled();
    } finally { await other.close(); }
  });
});

describe("network consistency", () => {
  it("the payment service refuses a ledger connection on another network", () => {
    expect(() => new XrplPaymentService({ xrplNetwork: "testnet" } as any, () => {}, "mainnet")).toThrow(/mainnet but its ledger connection is testnet/);
    expect(new XrplPaymentService({ xrplNetwork: "mainnet" } as any, () => {}).net).toBe("mainnet");
    expect(new XrplPaymentService({} as any, () => {}).net).toBe("testnet");
  });
  it("the send routes refuse to start with a testnet ledger connection when XRP mainnet custody is on", async () => {
    const bad = Fastify();
    await expect((async () => { await bad.register(custodySendRoutes, { provider, flags: on, network: { ...network, xrplNetwork: "testnet" } as any, submissionGate: () => {}, hmacKey: Buffer.alloc(32, 9) }); await bad.ready(); })()).rejects.toThrow(/ledger connection is testnet/);
    await bad.close().catch(() => undefined);
  });
});
