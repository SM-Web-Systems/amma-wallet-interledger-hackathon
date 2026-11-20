import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { Wallet, decode, deriveAddress } from "xrpl";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyPaymentStorage } from "../db/migrations/xrpl-payments";
import { applyReconciliationStorage } from "../db/migrations/xrpl-reconciliation";
import { applyIntegrationStorage } from "../db/migrations/xrpl-integration";
import { applyKeyEscrow } from "../db/migrations/key-escrow";
import { applyCustody } from "../db/migrations/custody";
import { applyCustodyV2 } from "../db/migrations/custody-v2";
import { LocalMasterKeyProvider, sealForEscrow } from "../lib/key-wrapper";
import { custodyLimitsFromEnv, type CustodyLimits } from "../lib/custody-limits";
import { setAppLogger } from "../lib/app-log";
import type { CustodyFlags } from "../lib/custody-flags";
import type { AccountSnapshot } from "../modules/xrpl/read-adapter";

const state = vi.hoisted(() => ({ db: undefined as any, userId: 1, enabled: true, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { STELLAR_NETWORK: "testnet", JWT_SECRET: "x", JWT_REFRESH_SECRET: "y", XRPL: { enabled: true }, get XRPL_PAYMENTS_ENABLED() { return state.enabled; } } }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));
vi.mock("../lib/key-recovery", () => ({ recoveryFreezeActive: async () => state.frozen }));

import { custodySendRoutes } from "./custody-send";
import { XrplPaymentService } from "../modules/xrpl/payment-service";

const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PASSWORD = "correct horse battery staple";
const XRPL = "rHfsP8wmWDEvSvBZu4VsF9BUB6wqXDo4xU";
const XRP = 1_000_000;
const HMAC = Buffer.alloc(32, 9);
const provider = new LocalMasterKeyProvider(Buffer.alloc(32, 7).toString("base64"));
const on: CustodyFlags = { serverSigning: true, welcomeFunding: false, sepoliaWei: 1n, dailyCap: 50 };
const referenceFor = (key: string) => { const h = createHmac("sha256", HMAC).update(`custody-send:xrpl:1:${key}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const plainReference = (key: string) => { const h = createHash("sha256").update(`custody-send:xrpl:1:${key}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const dest = Wallet.generate().classicAddress, dest2 = Wallet.generate().classicAddress;
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
const logs: string[] = [];
let limitsHook: (() => void) | null = null; let pg: PGlite, app: FastifyInstance, limits: CustodyLimits;
let walletId: number;
const send = (over: Record<string, unknown> = {}, a = app) => a.inject({
  method: "POST", url: "/api/v1/custody/xrpl/send",
  payload: { from: XRPL, to: dest, amountDrops: String(5 * XRP), password: PASSWORD, idempotencyKey: randomUUID(), ...over },
});
const count = async (t: string) => ((await pg.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0] as { n: number }).n;
const audits = async () => (await pg.query("SELECT action, detail FROM audit_logs ORDER BY id")).rows as { action: string; detail: any }[];
const seedPayment = async (o: { state?: string; amount: number; to?: string; ageHours?: number; source?: string; wallet?: number; fee?: number; key?: string; reference?: string }) => {
  const seedRef = o.reference ?? randomUUID();
  const st = o.state ?? "validated_success", prepared = !["awaiting_approval", "cancelled"].includes(st), signed = ["signed", "submitted", "validated_success"].includes(st);
  await pg.query(`INSERT INTO xrpl_payments (id,user_id,wallet_id,idempotency_key,request_digest,reference,source,request,state,
      preparation_id,preparation,signed_blob,transaction_hash,receipt,result_code,created_at)
    VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() - ($15 || ' hours')::interval)`,
  [randomUUID(), o.wallet ?? walletId, o.key ?? randomUUID(), "d".repeat(64), o.reference ?? seedRef, o.source ?? XRPL,
    JSON.stringify({ schemaVersion: 1, walletId: String(o.wallet ?? walletId), chain: "xrpl", network: "testnet", destination: o.to ?? dest2, amountDrops: String(o.amount), maxFeeDrops: "100", reference: o.reference ?? seedRef }), st,
    prepared ? randomUUID() : null, prepared ? JSON.stringify({ feeDrops: String(o.fee ?? 0) }) : null, signed ? "AB".repeat(60) : null, signed ? randomUUID().replace(/-/g, "").toUpperCase().padEnd(64, "A") : null,
    st === "validated_success" ? "{}" : null, st === "validated_success" ? "tesSUCCESS" : null, String(o.ageHours ?? 1)]);
};

beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  const conn = { execute: async (s: string) => { await pg.exec(s); }, rows: async (s: string) => (await pg.query(s)).rows as any };
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2]) await apply(conn);
  for (const apply of [applyPaymentStorage, applyReconciliationStorage, applyIntegrationStorage]) {
    await pg.transaction(tx => apply({ execute: async (s: string) => { await tx.exec(s); }, rows: async <T extends Record<string, unknown>>(s: string) => (await tx.query<T>(s)).rows }));
  }
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  state.db = drizzle(pg);
  await pg.query("UPDATE users SET password_hash = $1 WHERE id = 1", [await bcrypt.hash(PASSWORD, 4)]);
  setAppLogger({ info: (o, m) => logs.push(JSON.stringify({ o, m })), warn: (o, m) => logs.push(JSON.stringify({ o, m })), error: (o, m) => logs.push(JSON.stringify({ o, m })) });
  limits = custodyLimitsFromEnv({});
  app = Fastify();
  await app.register(custodySendRoutes, { provider, flags: on, limits: () => { limitsHook?.(); return limits; }, network, submissionGate: () => {}, hmacKey: HMAC });
  await app.ready();
}, 60000);
beforeEach(async () => {
  state.userId = 1; state.enabled = true; state.frozen = false; limits = custodyLimitsFromEnv({}); submitted.length = 0; logs.length = 0;
  vi.clearAllMocks();
  await pg.exec("TRUNCATE xrpl_receipt_claims,xrpl_payment_events,xrpl_payments RESTART IDENTITY CASCADE; TRUNCATE wallet_key_escrow; TRUNCATE audit_logs RESTART IDENTITY; DELETE FROM user_wallets; UPDATE users SET signing_mode='delegated'");
  walletId = ((await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'xrpl','testnet',$1,'x',true,0) RETURNING id", [XRPL])).rows[0] as { id: number }).id;
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", [await sealForEscrow(provider, PHRASE, { userId: 1, kind: "phrase" })]);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("POST /api/v1/custody/xrpl/send", () => {
  it("signs with the wallet's own derived key, submits through the payment pipeline and audits the send", async () => {
    const res = await send({ destinationTag: 7 });
    expect([200, 202]).toContain(res.statusCode);
    const body = res.json();
    expect(body.state).toBe("submitted");
    expect(body.hash).toMatch(/^[A-F0-9]{64}$/);
    expect(body.hash).toBe(body.transactionHash);
    expect(submitted).toHaveLength(1);
    const tx = decode(submitted[0]) as any;
    expect(deriveAddress(tx.SigningPubKey)).toBe(XRPL);
    expect(tx).toMatchObject({ Account: XRPL, Destination: dest, Amount: String(5 * XRP), DestinationTag: 7 });
    expect((await audits()).map((a) => a.action)).toEqual(["wallet_key_escrow_open", "wallet_custody_sign", "custody_send"]);
  });

  it("refuses a wrong password with 403, opens no escrow and creates no payment", async () => {
    const res = await send({ password: "nope" });
    expect(res.statusCode).toBe(403);
    expect((await audits()).map((a) => a.action)).toEqual(["wallet_custody_sign_denied"]);
    expect(await count("xrpl_payments")).toBe(0);
    expect(network.submitSigned).not.toHaveBeenCalled();
    expect(JSON.stringify(await audits()) + res.body + logs.join("")).not.toContain("nope");
  });

  it("refuses over the per-transaction limit with 403 and audits custody_limit_refused", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_TX_DROPS: String(10 * XRP) });
    const res = await send({ amountDrops: String(10 * XRP + 1) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/limit/);
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(["custody_limit_refused"]);
    expect(a[0].detail).toMatchObject({ chain: "xrpl", limit: "tx" });
    expect(await count("xrpl_payments")).toBe(0);
  });

  it("counts this wallet's sent payments from the last 24 hours towards the daily limit", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_DAY_DROPS: String(100 * XRP), CUSTODY_LIMIT_XRP_TX_DROPS: String(100 * XRP) });
    await seedPayment({ amount: 60 * XRP });
    await seedPayment({ amount: 500 * XRP, ageHours: 30 });         // too old
    await seedPayment({ amount: 500 * XRP, state: "cancelled" });   // never sent
    const refused = await send({ amountDrops: String(41 * XRP) });
    expect(refused.statusCode).toBe(403);
    expect((await audits()).find((a) => a.action === "custody_limit_refused")!.detail.limit).toBe("day");
    expect([200, 202]).toContain((await send({ amountDrops: String(39 * XRP) })).statusCode);
  });

  it("limits a first payment to a new address, but not to one this user has paid before", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS: String(10 * XRP) });
    const refused = await send({ amountDrops: String(20 * XRP) });
    expect(refused.statusCode).toBe(403);
    expect((await audits()).find((a) => a.action === "custody_limit_refused")!.detail.limit).toBe("new_recipient");
    await seedPayment({ amount: 1 * XRP, to: dest });
    expect([200, 202]).toContain((await send({ amountDrops: String(20 * XRP) })).statusCode);
  });

  it("refuses a from address that is not the user's, and another user's wallet", async () => {
    const other = Wallet.generate().classicAddress;
    expect((await send({ from: other })).statusCode).toBe(403);
    await pg.query("UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE id = 1) WHERE id = 2");
    state.userId = 2;
    const res = await send();
    expect(res.statusCode).toBe(403);
    expect(await count("xrpl_payments")).toBe(0);
    expect(network.submitSigned).not.toHaveBeenCalled();
  });

  it("is idempotent: the same key signs and submits once and returns the same payment", async () => {
    const key = randomUUID();
    const first = await send({ idempotencyKey: key });
    const again = await send({ idempotencyKey: key });
    expect([200, 202]).toContain(again.statusCode);
    expect(again.json().id).toBe(first.json().id);
    expect(again.json().hash).toBe(first.json().hash);
    expect(submitted).toHaveLength(1);
    expect(await count("xrpl_payments")).toBe(1);
    expect((await audits()).filter((a) => a.action === "custody_send")).toHaveLength(1);
  });

  it("refuses the same key with a different payment", async () => {
    const key = randomUUID();
    await send({ idempotencyKey: key });
    const res = await send({ idempotencyKey: key, amountDrops: String(6 * XRP) });
    expect(res.statusCode).toBe(409);
    expect(submitted).toHaveLength(1);
  });

  it("validates the body", async () => {
    for (const bad of [{ amountDrops: "0" }, { amountDrops: "1.5" }, { amountDrops: 5 }, { to: "not-an-address" }, { idempotencyKey: "x" }, { password: "" }, { destinationTag: -1 }, { extra: 1 }]) {
      const res = await send(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await count("xrpl_payments")).toBe(0);
  });

  it("is off when server signing is off, and when XRP payments are disabled", async () => {
    const gated = Fastify();
    await gated.register(custodySendRoutes, { provider, flags: { ...on, serverSigning: false }, network, submissionGate: () => {}, hmacKey: HMAC });
    const off = await send({}, gated);
    expect(off.statusCode).toBe(503);
    expect(off.json().error).toBe("Sending from Amma-held wallets is not switched on here.");
    state.enabled = false;
    expect((await send()).statusCode).toBe(503);
    await gated.close();
  });

  it("shares one daily budget across all of the user's XRP wallets and counts in-flight intents and fees", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_DAY_DROPS: String(100 * XRP), CUSTODY_LIMIT_XRP_TX_DROPS: String(100 * XRP), CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS: String(100 * XRP) });
    const other = ((await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'xrpl','testnet',$1,'x2',false,1) RETURNING id", [Wallet.generate().classicAddress])).rows[0] as { id: number }).id;
    await seedPayment({ amount: 40 * XRP, wallet: other, source: "rOTHERWALLET", state: "awaiting_approval" });
    await seedPayment({ amount: 30 * XRP, state: "prepared", fee: 12, source: "rSEEDPREPARED", wallet: other });
    expect((await send({ amountDrops: String(30 * XRP) })).statusCode).toBe(403);
    expect([200, 202]).toContain((await send({ amountDrops: String(29 * XRP) })).statusCode);
  });

  it("lets only one of several parallel sends through when the daily budget fits one", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_DAY_DROPS: String(10 * XRP), CUSTODY_LIMIT_XRP_TX_DROPS: String(10 * XRP), CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS: String(10 * XRP) });
    const results = await Promise.all([1, 2, 3, 4].map(() => send({ amountDrops: String(6 * XRP) })));
    expect(results.filter((r) => r.statusCode === 200 || r.statusCode === 202)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 403)).toHaveLength(3);
    expect(submitted).toHaveLength(1);
    expect(await count("xrpl_payments")).toBe(1);
  });

  it("re-checks the limits when an unsent intent for the same key is retried, and cancels it if it no longer fits", async () => {
    const key = randomUUID();
    await seedPayment({ amount: 20 * XRP, state: "awaiting_approval", key, reference: referenceFor(key), to: dest });
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_TX_DROPS: String(10 * XRP) });
    const res = await send({ idempotencyKey: key, amountDrops: String(20 * XRP) });
    expect(res.statusCode).toBe(403);
    expect(submitted).toHaveLength(0);
    expect((await pg.query("SELECT state FROM xrpl_payments WHERE idempotency_key=$1", [key])).rows).toEqual([{ state: "cancelled" }]);
  });

  it("fails safe when another send lands after the pre-check: every other counted intent counts, not only earlier ones", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_DAY_DROPS: String(10 * XRP), CUSTODY_LIMIT_XRP_TX_DROPS: String(10 * XRP), CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS: String(10 * XRP) });
    const other = ((await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'xrpl','testnet',$1,'x2',false,1) RETURNING id", [Wallet.generate().classicAddress])).rows[0] as { id: number }).id;
    // A competing intent from another instance appears, sorting after ours, right after this send has passed its pre-check.
    let competing: Promise<unknown> | null = null;
    limitsHook = () => {
      limitsHook = null;
      competing = seedPayment({ amount: 6 * XRP, state: "awaiting_approval", wallet: other, source: "rCOMPETITOR" })
        .then(() => pg.exec("UPDATE xrpl_payments SET created_at = now() + interval '1 hour' WHERE source = 'rCOMPETITOR'"));
    };
    const res = await send({ amountDrops: String(6 * XRP) });
    await competing;
    expect(res.statusCode).toBe(403);
    expect(submitted).toHaveLength(0);
    expect((await pg.query("SELECT state FROM xrpl_payments WHERE source = $1", [XRPL])).rows).toEqual([{ state: "cancelled" }]);
  });

  it("does not cancel the original intent when a retry with the same key asks for a different payment", async () => {
    const key = randomUUID();
    await seedPayment({ amount: 20 * XRP, state: "awaiting_approval", key, reference: referenceFor(key), to: dest });
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_TX_DROPS: String(10 * XRP) });
    const res = await send({ idempotencyKey: key, amountDrops: String(30 * XRP) });
    expect([403, 409]).toContain(res.statusCode);
    expect((await pg.query("SELECT state FROM xrpl_payments WHERE idempotency_key=$1", [key])).rows).toEqual([{ state: "awaiting_approval" }]);
  });

  it("tells the caller how many unfinished intents are using the budget when a limit refuses", async () => {
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_DAY_DROPS: String(10 * XRP), CUSTODY_LIMIT_XRP_TX_DROPS: String(10 * XRP), CUSTODY_NEW_RECIPIENT_MAX_XRP_DROPS: String(10 * XRP) });
    await seedPayment({ amount: 4 * XRP, state: "awaiting_approval" });
    await seedPayment({ amount: 4 * XRP, state: "awaiting_approval" });
    const res = await send({ amountDrops: String(5 * XRP) });
    expect(res.statusCode).toBe(403);
    expect(res.json().awaitingIntents).toBe(2);
    expect(res.json().error).toMatch(/2 payments? waiting for approval/);
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_TX_DROPS: String(1 * XRP) });
    expect((await send({ amountDrops: String(5 * XRP) })).json().awaitingIntents).toBe(2);
    await pg.exec("DELETE FROM xrpl_payment_events; DELETE FROM xrpl_payments");
    limits = custodyLimitsFromEnv({ CUSTODY_LIMIT_XRP_TX_DROPS: String(1 * XRP) });
    expect((await send({ amountDrops: String(5 * XRP) })).json().awaitingIntents).toBeUndefined();
  });

  it("also reports waiting intents when another payment from the wallet is still unresolved (409)", async () => {
    await seedPayment({ amount: 1 * XRP, state: "prepared" });
    await seedPayment({ amount: 1 * XRP, state: "awaiting_approval", wallet: ((await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'xrpl','testnet','rOTHERSEED','x3',false,2) RETURNING id")).rows[0] as { id: number }).id, source: "rOTHERSEED" });
    const res = await send();
    expect(res.statusCode).toBe(409);
    expect(res.json().awaitingIntents).toBe(1);
  });

  it("refuses to sign an intent that was created through the public payment-intents route", async () => {
    const key = randomUUID();
    await seedPayment({ amount: 5 * XRP, state: "awaiting_approval", key, to: dest });
    const res = await send({ idempotencyKey: key });
    expect(res.statusCode).toBe(409);
    expect(submitted).toHaveLength(0);
    expect((await audits()).map((a) => a.action)).not.toContain("wallet_key_escrow_open");
    const key2 = randomUUID();
    await seedPayment({ amount: 5 * XRP, state: "awaiting_approval", key: key2, to: dest, reference: plainReference(key2) });
    expect((await send({ idempotencyKey: key2 })).statusCode).toBe(409);
    expect(submitted).toHaveLength(0);
  });

  it("creates nothing for a frozen account, a self-signing account, or a wallet without a derivation index or custody phrase", async () => {
    state.frozen = true;
    expect((await send()).statusCode).toBe(423);
    state.frozen = false;
    await pg.exec("UPDATE users SET signing_mode='self'");
    expect((await send()).statusCode).toBe(403);
    await pg.exec("UPDATE users SET signing_mode='delegated'; UPDATE user_wallets SET derivation_index = NULL");
    expect((await send()).statusCode).toBe(403);
    await pg.exec("UPDATE user_wallets SET derivation_index = 0; UPDATE wallet_key_escrow SET origin = 'client'");
    expect((await send()).statusCode).toBe(403);
    expect(await count("xrpl_payments")).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it("does not submit when the send cannot be recorded in the audit log", async () => {
    await pg.exec("ALTER TABLE audit_logs ADD CONSTRAINT no_send CHECK (action <> 'custody_send')");
    try {
      const res = await send();
      expect(res.statusCode).toBe(503);
      expect(submitted).toHaveLength(0);
    } finally { await pg.exec("ALTER TABLE audit_logs DROP CONSTRAINT no_send"); }
  });

  it("answers 202 with the hash, not 'Nothing was lost', when the payment was signed and then something failed", async () => {
    const real = XrplPaymentService.prototype.submit;
    const spy = vi.spyOn(XrplPaymentService.prototype, "submit").mockImplementationOnce(async function (this: XrplPaymentService, ...args: Parameters<XrplPaymentService["submit"]>) {
      await real.apply(this, args);
      throw new Error("socket hang up");
    });
    try {
      const res = await send();
      expect(submitted).toHaveLength(1);
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body).toMatchObject({ status: "unknown", error: "The payment was signed but could not be confirmed as sent. Check its status before trying again." });
      expect(body.hash).toMatch(/^[A-F0-9]{64}$/);
      expect(body.transactionHash).toBe(body.hash);
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body).not.toMatch(/Nothing was lost/);
    } finally { spy.mockRestore(); }
  });

  it("explains failures in plain English", async () => {
    network.getAccount.mockImplementation(async (a: string) => ({ ...account(a), spendableDrops: "1000" }));
    const res = await send();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not enough XRP/i);
  });

  it("never puts the phrase, password or a key in the response, the logs or the audit rows", async () => {
    const res = await send();
    await send({ password: "wrong-pw-1" });
    const all = res.body + logs.join("") + JSON.stringify(await audits()) + JSON.stringify((await pg.query("SELECT request, preparation FROM xrpl_payments")).rows);
    for (const secret of [PASSWORD, "wrong-pw-1", "illness", "bargain", "privateKey", "seed"]) expect(all).not.toContain(secret);
  });
});
