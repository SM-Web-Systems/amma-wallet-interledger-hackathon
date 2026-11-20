import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { activationDatabase, connectionOf } from "../db/migrations/activation.test-support";
import { applyCreditsV1 } from "../db/migrations/credits-v1";
import { chargeManagementAllTenants, chargeManagementForTenant } from "./management-fee.service";

let pg: PGlite;
let db: any;
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const pot = async () => (await q("SELECT management_xlm::text AS m FROM tenant_credit_balances WHERE tenant_id=1"))[0].m as string;
const now = new Date("2026-12-03T00:00:00Z");
const november = new Date("2026-11-01T00:00:00Z");

let walletSeq = 0;
async function wallet(plan: "monthly" | "annual", confirmedAt: string, opts: { state?: string; paidUntil?: string; deletedAt?: string } = {}) {
  const n = ++walletSeq;
  await pg.query(`INSERT INTO user_wallets (id, user_id, chain, network, public_key, name, is_active, derivation_index) VALUES ($1::int, 1, 'stellar', 'testnet', $2, 'w', false, $3::int)`, [n, `GADDR${n}`, n]);
  await pg.query("INSERT INTO partner_tasks (id, tenant_id, task_key, name, chains, created_by) VALUES ($1, 1, $2, 'Course', '{stellar}', 'test')", [n, `course:${n}`]);
  await pg.query(`INSERT INTO partner_task_completions (id, tenant_id, task_id, user_id, api_key_id, signing_key_id, partner_completion_id, idempotency_key, request_digest, completed_at)
    VALUES ($1, 1, $1, 1, 1, 1, $2, $3, repeat('a',64), now())`, [n, `completion-${n}-xx`, `idem-key-${n}-xx`]);
  await pg.query(`INSERT INTO wallet_activations (completion_id, tenant_id, user_id, wallet_id, chain, network, address, payer, grant_base_units, state, confirmed_at, credit_plan, management_paid_until, deleted_at)
    VALUES ($1, 1, 1, $8, 'stellar', 'testnet', $2, 'tenant', 11000000, $3, $4, $5, $6, $7)`,
    [n, `GADDR${n}`, opts.state ?? "confirmed", confirmedAt, plan, opts.paidUntil ?? null, opts.deletedAt ?? null, n]);
}

beforeAll(async () => {
  pg = await activationDatabase();
  await pg.transaction((tx) => applyCreditsV1(connectionOf(tx)));
  db = drizzle(pg);
}, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  walletSeq = 0;
  await pg.exec(`TRUNCATE tenants, tenant_api_keys, partner_signing_keys, partner_tasks, partner_task_completions, wallet_activations, user_wallets, tenant_credit_balances, credit_ledger RESTART IDENTITY CASCADE;
    INSERT INTO tenants (id, slug, name) VALUES (1, 'lms', 'LMS');
    INSERT INTO tenant_api_keys (tenant_id, name, key_hash, key_prefix) VALUES (1, 'k', 'h', 'p');
    INSERT INTO partner_signing_keys (tenant_id, key_id, public_key) VALUES (1, 'key-1', '${"A".repeat(43)}=');
    INSERT INTO tenant_credit_balances (tenant_id, management_xlm) VALUES (1, 3.4)`);
});

describe("monthly wallet management fee", () => {
  it("charges 0.1 XLM per live credit wallet for the finished month, from the management pot", async () => {
    await wallet("monthly", "2026-10-15T00:00:00Z");
    await wallet("monthly", "2026-11-30T23:00:00Z");
    await wallet("monthly", "2026-12-01T09:00:00Z"); // activated after November: not charged for it
    await wallet("annual", "2026-11-02T00:00:00Z", { paidUntil: "2027-11-02T00:00:00Z" }); // inside its prepaid year
    await wallet("monthly", "2026-11-05T00:00:00Z", { state: "refunded" }); // never funded
    await wallet("monthly", "2026-06-01T00:00:00Z", { deletedAt: "2026-10-20T00:00:00Z" }); // deleted before November
    const result = await chargeManagementForTenant(db, 1, november, now);
    expect(result).toEqual({ tenantId: 1, period: "2026-11", billableWallets: 2, amount: "0.2000000", charged: true });
    expect(await pot()).toBe("3.2000000");
    expect(await q("SELECT event, management_delta_xlm::text AS m, fee_xlm::text AS f, idempotency_key AS k FROM credit_ledger"))
      .toEqual([{ event: "management_charge", m: "-0.2000000", f: "0.2000000", k: "management:2026-11" }]);
  });

  it("charges a month only once, however often the job runs", async () => {
    await wallet("monthly", "2026-10-15T00:00:00Z");
    await chargeManagementForTenant(db, 1, november, now);
    expect((await chargeManagementForTenant(db, 1, november, now)).charged).toBe(false);
    await chargeManagementAllTenants(db, now);
    expect(await pot()).toBe("3.3000000");
    expect((await q("SELECT count(*)::int AS n FROM credit_ledger"))[0].n).toBe(1);
  });

  it("refuses to charge a month that hasn't ended", async () => {
    await expect(chargeManagementForTenant(db, 1, new Date("2026-12-01T00:00:00Z"), now)).rejects.toThrow("finished month");
  });

  it("writes nothing when no wallet is billable", async () => {
    expect((await chargeManagementForTenant(db, 1, november, now)).charged).toBe(false);
    expect((await q("SELECT count(*)::int AS n FROM credit_ledger"))[0].n).toBe(0);
  });

  it("the all-tenants run charges last month for businesses with a credit account only", async () => {
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (2, 'old', 'Old model')");
    await wallet("monthly", "2026-10-15T00:00:00Z");
    const results = await chargeManagementAllTenants(db, now);
    expect(results.map((r) => [r.tenantId, r.period, r.charged])).toEqual([[1, "2026-11", true]]);
  });

  it("can take the pot below zero: the floor check (stage 5) stops new activations then", async () => {
    await pg.exec("UPDATE tenant_credit_balances SET management_xlm = 0.05");
    await wallet("monthly", "2026-10-15T00:00:00Z");
    await chargeManagementForTenant(db, 1, november, now);
    expect(await pot()).toBe("-0.0500000");
  });
});
