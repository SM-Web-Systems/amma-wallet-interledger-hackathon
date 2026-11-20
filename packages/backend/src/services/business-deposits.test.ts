import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { activationDatabase, connectionOf } from "../db/migrations/activation.test-support";
import { applyCreditsV1 } from "../db/migrations/credits-v1";
import { applyBusinessWalletsV1 } from "../db/migrations/business-wallets-v1";
import { applyBusinessDepositsV1 } from "../db/migrations/business-deposits-v1";
import { setAppLogger } from "../lib/app-log";
vi.mock("../db", () => ({ db: {}, schema: {} }));
import { incomingXlm, scanBusinessDeposits, type HorizonPayment, type PaymentFeed } from "./business-deposits";

let pg: PGlite;
let db: any;
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const now = new Date("2026-11-18T08:00:00Z");
const WALLET = Keypair.random().publicKey();
const WALLET_2 = Keypair.random().publicKey();
const PAYER = Keypair.random().publicKey();
const FEE = Keypair.random().publicKey();
const logs: string[] = [];
let mails: { to: string; subject: string; html: string }[] = [];
let mailWorks = true;
const mail = async (to: string, subject: string, html: string) => { if (!mailWorks) return false; mails.push({ to, subject, html }); return true; };

let op = 1000;
const pay = (amount: string, over: Partial<HorizonPayment> = {}): HorizonPayment => {
  const id = String(++op);
  return { id, paging_token: id, type: "payment", transaction_hash: id.padStart(64, "0"), transaction_successful: true, created_at: "2026-11-18T07:59:00Z", asset_type: "native", from: PAYER, to: WALLET, amount, ...over };
};
class FakeFeed implements PaymentFeed {
  constructor(public byAddress: Record<string, HorizonPayment[]>, public broken = new Set<string>()) {}
  async payments(address: string, cursor: string | null, limit: number) {
    if (this.broken.has(address)) throw new Error("horizon down");
    return (this.byAddress[address] ?? []).filter((r) => cursor === null || BigInt(r.paging_token) > BigInt(cursor)).slice(0, limit);
  }
}
const scan = (feed: PaymentFeed) => scanBusinessDeposits(db, { feed, network: "testnet", now: () => now, mail, escalateTo: "owner@example.test" });
const balances = async () => (await q("SELECT annual_credits AS annual, monthly_credits AS monthly, funding_xlm::text AS funding, management_xlm::text AS management, registration_fee_paid_at IS NOT NULL AS paid FROM tenant_credit_balances WHERE tenant_id=1"))[0];

beforeAll(async () => {
  pg = await activationDatabase();
  for (const apply of [applyCreditsV1, applyBusinessWalletsV1, applyBusinessDepositsV1]) await pg.transaction((tx) => apply(connectionOf(tx)));
  db = drizzle(pg);
}, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  logs.length = 0; mails = []; mailWorks = true;
  setAppLogger({ info: () => {}, warn: (_o, m) => logs.push(m), error: (_o, m) => logs.push(m) });
  await pg.exec(`TRUNCATE tenants, audit_logs, tenant_bundle_purchases, tenant_alert_log RESTART IDENTITY CASCADE;
    INSERT INTO tenants (id, slug, name) VALUES (1,'lms','LMS'), (2,'other','Other')`);
  await pg.query("INSERT INTO business_wallets (tenant_id, network, address, sealed_secret, provider, created_by) VALUES (1,'testnet',$1,$2,'local','t'), (2,'testnet',$3,$2,'local','t')", [WALLET, "x".repeat(60), WALLET_2]);
  await pg.query("INSERT INTO fee_address_pool (network, address, added_by) VALUES ('testnet',$1,'owner')", [FEE]);
});
afterEach(() => setAppLogger(null));

describe("which Horizon records are deposits", () => {
  it("counts incoming XLM payments and account creation, and nothing else", () => {
    expect(incomingXlm(pay("341"), WALLET)).toEqual({ from: PAYER, amount: "341" });
    expect(incomingXlm(pay("5", { type: "create_account", account: WALLET, funder: PAYER, starting_balance: "5.0000000", to: undefined, from: undefined }), WALLET)).toEqual({ from: PAYER, amount: "5.0000000" });
    expect(incomingXlm(pay("341", { from: WALLET, to: PAYER }), WALLET)).toBeNull(); // outgoing
    expect(incomingXlm(pay("341", { asset_type: "credit_alphanum4" }), WALLET)).toBeNull();
    expect(incomingXlm(pay("341", { transaction_successful: false }), WALLET)).toBeNull();
    expect(incomingXlm(pay("341", { type: "account_merge" }), WALLET)).toBeNull();
  });
});

describe("business deposit watcher", () => {
  it("credits the LMS's first monthly bundle (registration waived): 340 + 1 reserve, with a receipt and the fee owed", async () => {
    await pg.exec("INSERT INTO tenant_credit_balances (tenant_id, registration_fee_waived) VALUES (1, true)");
    const feed = new FakeFeed({ [WALLET]: [pay("341.0000000")] });
    expect(await scan(feed)).toMatchObject({ wallets: 2, credited: 1, held: 0 });
    expect(await balances()).toEqual({ annual: 0, monthly: 100, funding: "110.0000000", management: "30.0000000", paid: false });
    const d = (await q("SELECT state, bundle_slug, fee_due_xlm::text AS fee, reserve_xlm::text AS reserve, registration_xlm::text AS reg FROM business_deposits"))[0];
    expect(d).toEqual({ state: "credited", bundle_slug: "monthly-100", fee: "200.0000000", reserve: "1.0000000", reg: "0.0000000" });
    expect(await q("SELECT event, monthly_credits_delta AS m, fee_xlm::text AS fee FROM credit_ledger")).toEqual([{ event: "bundle_credit", m: 100, fee: "200.0000000" }]);
    expect(await q("SELECT bundle_slug_snapshot AS slug, amount_xlm::text AS amount FROM tenant_bundle_purchases")).toEqual([{ slug: "monthly-100", amount: "341.0000000" }]);
    expect(Number((await q("SELECT tenant_id FROM fee_address_pool"))[0].tenant_id)).toBe(1);
  });

  it("a first annual deposit carries the registration fee, which is booked and owed to the fee address", async () => {
    const feed = new FakeFeed({ [WALLET]: [pay("511")] }); // 410 + 100 registration + 1 reserve
    await scan(feed);
    expect(await balances()).toEqual({ annual: 100, monthly: 0, funding: "110.0000000", management: "0.0000000", paid: true });
    expect((await q("SELECT fee_due_xlm::text AS f FROM business_deposits"))[0].f).toBe("400.0000000"); // 200 fee + 100 yearly management + 100 registration
    expect((await q("SELECT event, fee_xlm::text AS f FROM credit_ledger ORDER BY id"))).toEqual([{ event: "bundle_credit", f: "300.0000000" }, { event: "registration_fee", f: "100.0000000" }]);
  });

  it("a later deposit is the plain bundle price; the first-deposit price is held then", async () => {
    await pg.exec("INSERT INTO tenant_credit_balances (tenant_id, registration_fee_waived) VALUES (1, true)");
    const feed = new FakeFeed({ [WALLET]: [pay("341"), pay("680"), pay("341")] });
    expect(await scan(feed)).toMatchObject({ credited: 2, held: 1 });
    expect((await balances()).monthly).toBe(300);
  });

  it("holds an odd amount, credits nothing, and emails the owner once", async () => {
    const feed = new FakeFeed({ [WALLET]: [pay("100")] });
    expect(await scan(feed)).toMatchObject({ credited: 0, held: 1 });
    expect(await balances()).toMatchObject({ annual: 0, monthly: 0, funding: "0.0000000" });
    expect(await q("SELECT count(*)::int AS n FROM credit_ledger")).toEqual([{ n: 0 }]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "owner@example.test", subject: expect.stringContaining("100.0000000 XLM") });
    expect(mails[0].html).toContain("match any bundle price");
    await scan(feed);
    expect(mails).toHaveLength(1);
    expect(await q("SELECT alert_type, delivered FROM tenant_alert_log")).toEqual([{ alert_type: "unallocated_deposit", delivered: true }]);
  });

  it("retries a failed escalation email after 30 minutes, not on every pass", async () => {
    mailWorks = false;
    await scan(new FakeFeed({ [WALLET]: [pay("99")] }));
    expect(logs).toContain("business_deposit_escalation_failed");
    mailWorks = true;
    await scan(new FakeFeed({}));
    expect(mails).toHaveLength(0);
    await pg.exec("UPDATE business_deposits SET escalation_tried_at = escalation_tried_at - interval '31 minutes'");
    await scan(new FakeFeed({}));
    expect(mails).toHaveLength(1);
  });

  it("never counts a payment twice, even if Horizon serves it again", async () => {
    await pg.exec("INSERT INTO tenant_credit_balances (tenant_id, registration_fee_waived) VALUES (1, true)");
    const p = pay("341");
    await scan(new FakeFeed({ [WALLET]: [p] }));
    await pg.exec("UPDATE business_wallets SET deposit_cursor = NULL");
    expect(await scan(new FakeFeed({ [WALLET]: [p] }))).toMatchObject({ credited: 0, skipped: 1 });
    expect((await balances()).monthly).toBe(100);
  });

  it("moves the cursor past outgoing and other-asset records, and one wallet's Horizon failure doesn't stop the others", async () => {
    await pg.exec("INSERT INTO tenant_credit_balances (tenant_id, registration_fee_waived) VALUES (1, true)");
    const out = pay("5", { from: WALLET, to: PAYER });
    const credit = pay("341");
    const feed = new FakeFeed({ [WALLET]: [out, credit], [WALLET_2]: [pay("1", { to: WALLET_2 })] }, new Set([WALLET_2]));
    expect(await scan(feed)).toMatchObject({ credited: 1, skipped: 1, failedWallets: 1 });
    expect((await q("SELECT deposit_cursor FROM business_wallets WHERE tenant_id = 1"))[0].deposit_cursor).toBe(credit.paging_token);
    expect((await q("SELECT deposit_cursor FROM business_wallets WHERE tenant_id = 2"))[0].deposit_cursor).toBeNull();
    expect(logs).toContain("business_deposit_scan_failed");
  });

  it("still credits when no fee address is free, and says so", async () => {
    await pg.exec("DELETE FROM fee_address_pool; INSERT INTO tenant_credit_balances (tenant_id, registration_fee_waived) VALUES (1, true)");
    expect(await scan(new FakeFeed({ [WALLET]: [pay("341")] }))).toMatchObject({ credited: 1 });
    expect(logs).toContain("fee_address_unassigned");
  });
});
