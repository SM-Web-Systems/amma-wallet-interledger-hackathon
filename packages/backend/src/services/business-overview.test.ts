import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { activationDatabase, connectionOf } from "../db/migrations/activation.test-support";
import { applyCreditsV1 } from "../db/migrations/credits-v1";
import { applyBusinessWalletsV1 } from "../db/migrations/business-wallets-v1";
import { applyBusinessDepositsV1 } from "../db/migrations/business-deposits-v1";
import { applyFeeSweepsV1 } from "../db/migrations/fee-sweeps-v1";
vi.mock("../db", () => ({ db: {}, schema: {} }));
import { getBusinessOverview } from "./business-overview";

// The self-serve business page: one business's credits, deposits (credited or held), fees and purchases, and how to deposit.
let pg: PGlite;
let db: any;
const WALLET = Keypair.random().publicKey();
const OTHER_WALLET = Keypair.random().publicKey();
const PAYER = Keypair.random().publicKey();
const FEE_ADDR = Keypair.random().publicKey();
const SECRET = "s".repeat(60);
let op = 5000;
const deposit = async (tenant: number, amount: string, state: "credited" | "held", over: Record<string, unknown> = {}) => {
  const id = String(++op);
  const row: Record<string, unknown> = { bundle_slug: null, plan: null, users: null, held_reason: "no_bundle_matches_amount", fee_due_xlm: "0", credit_ledger_id: null, ...over };
  if (state === "credited" && row.credit_ledger_id === null) {
    const l = await pg.query<{ id: number }>("INSERT INTO credit_ledger (tenant_id, event, plan, idempotency_key, created_by) VALUES ($1,'bundle_credit','monthly',$2,'t') RETURNING id", [tenant, "dep-" + id]);
    row.credit_ledger_id = l.rows[0].id;
  }
  await pg.query(`INSERT INTO business_deposits (tenant_id, network, wallet_address, operation_id, tx_hash, from_address, amount_xlm, received_at, state, held_reason, bundle_slug, plan, users, fee_due_xlm, credit_ledger_id)
    VALUES ($1,'testnet',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [tenant, tenant === 1 ? WALLET : OTHER_WALLET, id, id.padStart(64, "0"), PAYER, amount, `2026-11-18T0${op % 9}:00:00Z`, state,
      state === "held" ? row.held_reason : null, row.bundle_slug, row.plan, row.users, row.fee_due_xlm, row.credit_ledger_id]);
  return id;
};

beforeAll(async () => {
  pg = await activationDatabase();
  for (const a of [applyCreditsV1, applyBusinessWalletsV1, applyBusinessDepositsV1, applyFeeSweepsV1]) await pg.transaction((tx) => a(connectionOf(tx)));
  db = drizzle(pg);
}, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  await pg.exec(`DELETE FROM bundle_catalog WHERE slug = 'monthly-100-copy';
    TRUNCATE tenants, tenant_bundle_purchases, credit_ledger, business_deposits, fee_sweeps RESTART IDENTITY CASCADE;
    INSERT INTO tenants (id, slug, name) VALUES (1,'lms','LMS'), (2,'other','Other')`);
  await pg.query("INSERT INTO business_wallets (tenant_id, network, address, sealed_secret, provider, created_by) VALUES (1,'testnet',$1,$3,'local','t'), (2,'testnet',$2,$3,'local','t')", [WALLET, OTHER_WALLET, SECRET]);
});

describe("business overview", () => {
  it("a business with nothing yet: its deposit address, no memo, and the exact first-deposit amounts", async () => {
    const o = await getBusinessOverview(db, 1, "testnet");
    expect(o.depositAddress).toBe(WALLET);
    expect(o.memo).toBeNull();
    expect(o.firstDeposit).toBe(true);
    expect(o.credits).toEqual({ annualCredits: 0, monthlyCredits: 0, fundingXlm: "0.0000000", managementXlm: "0.0000000", registrationFeeWaived: false });
    // monthly-100 on a first deposit: 100 x (1.1 + 2 + 0.3) = 340, + 100 registration + 1 reserve.
    expect(o.bundles.find((b) => b.slug === "monthly-100")).toMatchObject({ plan: "monthly", users: 100, sendXlm: "441.0000000" });
    expect(o.deposits).toEqual([]);
    expect(o.purchases).toEqual([]);
    expect(o.accountActive).toBe(true);
    expect(o.fees).toEqual({ onDepositsXlm: "0.0000000", managementXlm: "0.0000000", chargedXlm: "0.0000000", paidXlm: "0.0000000", pendingXlm: "0.0000000", failedXlm: "0.0000000" });
  });

  it("registration waived: the first-deposit amount drops the 100 XLM fee", async () => {
    await pg.exec("INSERT INTO tenant_credit_balances (tenant_id, registration_fee_waived) VALUES (1, true)");
    const o = await getBusinessOverview(db, 1, "testnet");
    expect(o.bundles.find((b) => b.slug === "monthly-100")?.sendXlm).toBe("341.0000000");
  });

  it("after a credited deposit: balances, later amounts without extras, credited and held deposits, fees due, paid and pending", async () => {
    await pg.exec("INSERT INTO tenant_credit_balances (tenant_id, monthly_credits, funding_xlm, management_xlm) VALUES (1, 100, 110, 30)");
    const credited = await deposit(1, "441.0000000", "credited", { bundle_slug: "monthly-100", plan: "monthly", users: 100, fee_due_xlm: "300" });
    await pg.query("INSERT INTO credit_ledger (tenant_id, event, management_delta_xlm, fee_xlm, idempotency_key, created_by) VALUES (1,'management_charge',-0.4,0.4,'management:2026-11','monthly-job')");
    await deposit(1, "12.5000000", "held");
    await pg.query("INSERT INTO fee_sweeps (tenant_id, network, source_ref, amount_xlm, state, tx_hash, confirmed_at, to_address) VALUES (1,'testnet',$1,200,'confirmed',$2,now(),$3)", [`deposit:${credited}`, "a".repeat(64), FEE_ADDR]);
    await pg.query("INSERT INTO fee_sweeps (tenant_id, network, source_ref, amount_xlm, state) VALUES (1,'testnet','management:1',0.4,'pending')");
    const p = await pg.query<{ id: number }>("INSERT INTO tenant_bundle_purchases (tenant_id, bundle_slug_snapshot, bundle_name_snapshot, amount_xlm, approx_users_snapshot, payment_reference) VALUES (1,'monthly-100','Monthly 100',441,100,$1) RETURNING id", ["b".repeat(64)]);
    await pg.query("UPDATE business_deposits SET bundle_purchase_id = $1 WHERE operation_id = $2", [p.rows[0].id, credited]);
    // An admin-recorded purchase from the old prepaid path is not a deposit receipt and is not listed.
    await pg.query("INSERT INTO tenant_bundle_purchases (tenant_id, bundle_slug_snapshot, bundle_name_snapshot, amount_xlm) VALUES (1,'starter-100','Starter 100',300)");
    await pg.query("INSERT INTO fee_sweeps (tenant_id, network, source_ref, amount_xlm, state, attempts) VALUES (1,'testnet','management:99',1.5,'failed',3)");

    const o = await getBusinessOverview(db, 1, "testnet");
    expect(o.firstDeposit).toBe(false);
    expect(o.credits).toMatchObject({ monthlyCredits: 100, fundingXlm: "110.0000000", managementXlm: "30.0000000" });
    expect(o.bundles.find((b) => b.slug === "monthly-100")?.sendXlm).toBe("340.0000000");
    expect(o.deposits).toHaveLength(2);
    expect(o.deposits.map((d) => d.state).sort()).toEqual(["credited", "held"]);
    expect(o.deposits.find((d) => d.state === "held")).toMatchObject({ amountXlm: "12.5000000", heldReason: "no_bundle_matches_amount", bundleSlug: null });
    expect(o.deposits.find((d) => d.state === "credited")).toMatchObject({ bundleSlug: "monthly-100", plan: "monthly", users: 100, feeDueXlm: "300.0000000" });
    expect(o.fees).toEqual({ onDepositsXlm: "300.0000000", managementXlm: "0.4000000", chargedXlm: "300.4000000", paidXlm: "200.0000000", pendingXlm: "0.4000000", failedXlm: "1.5000000" });
    expect(o.purchases).toEqual([expect.objectContaining({ bundleSlug: "monthly-100", bundleName: "Monthly 100", amountXlm: "441.0000000", users: 100 })]);
  });

  it("shows one business only: another business's rows never appear", async () => {
    await deposit(2, "99.0000000", "held");
    await pg.query("INSERT INTO tenant_bundle_purchases (tenant_id, bundle_slug_snapshot, bundle_name_snapshot, amount_xlm) VALUES (2,'x','X',1)");
    await pg.query("INSERT INTO fee_sweeps (tenant_id, network, source_ref, amount_xlm, state) VALUES (2,'testnet','management:9',5,'pending')");
    const o = await getBusinessOverview(db, 1, "testnet");
    expect(o.depositAddress).toBe(WALLET);
    expect(o.deposits).toEqual([]);
    expect(o.purchases).toEqual([]);
    expect(o.fees.pendingXlm).toBe("0.0000000");
  });

  it("never returns the sealed wallet secret", async () => {
    await deposit(1, "1.0000000", "held");
    expect(JSON.stringify(await getBusinessOverview(db, 1, "testnet"))).not.toContain(SECRET);
  });

  it("no wallet yet (or a retired one): no deposit address, so the page says the wallet is not set up", async () => {
    await pg.exec("UPDATE business_wallets SET retired_at = now() WHERE tenant_id = 1");
    expect((await getBusinessOverview(db, 1, "testnet")).depositAddress).toBeNull();
  });

  it("leaves out bundles that share a deposit amount: that amount would be held, not credited", async () => {
    await pg.exec("INSERT INTO bundle_catalog (slug, name, users, plan, is_active, sort_order) VALUES ('monthly-100-copy','Monthly 100 (copy)',100,'monthly',true,99)");
    const o = await getBusinessOverview(db, 1, "testnet");
    expect(o.bundles.map((b) => b.slug)).not.toContain("monthly-100");
    expect(o.bundles.map((b) => b.slug)).not.toContain("monthly-100-copy");
    expect(o.bundles.length).toBeGreaterThan(0);
  });

  it("a suspended or inactive business gets no deposit instructions", async () => {
    await pg.exec("UPDATE tenants SET suspended_at = now() WHERE id = 1");
    let o = await getBusinessOverview(db, 1, "testnet");
    expect(o).toMatchObject({ accountActive: false, depositAddress: null, bundles: [] });
    await pg.exec("UPDATE tenants SET suspended_at = NULL, is_active = false WHERE id = 1");
    o = await getBusinessOverview(db, 1, "testnet");
    expect(o).toMatchObject({ accountActive: false, depositAddress: null, bundles: [] });
  });

  it("lists the newest 50 deposits first", async () => {
    for (let i = 0; i < 55; i++) await deposit(1, `${i + 1}.0000000`, "held");
    const o = await getBusinessOverview(db, 1, "testnet");
    expect(o.deposits).toHaveLength(50);
    const times = o.deposits.map((d) => d.receivedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });
});
