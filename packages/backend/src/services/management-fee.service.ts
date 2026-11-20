/**
 * Monthly wallet management fee under business credits (BUSINESS_CREDITS=on; owner decisions of 16 Nov 2026).
 *
 * Charged in arrears: after a calendar month ends, each business pays 0.1 XLM for every wallet it activated with a credit
 * that was live in that month (see isBillable in credit-plans.ts). Sign-ins play no part. The charge comes out of the
 * business's management pot and is recorded once per business and month in credit_ledger. Moving the XLM itself to the
 * business's fee address happens with the fee sweeps (stage 3).
 */
import { sql } from "drizzle-orm";
import { monthStart, monthlyManagementCharge, type ManagedWallet, type Plan } from "./credit-plans";
import { rowsOf, type ActivationDb } from "../modules/activation/errors";

export interface ManagementChargeResult { tenantId: number; period: string; billableWallets: number; amount: string; charged: boolean }

export const periodOf = (month: Date): string => monthStart(month).toISOString().slice(0, 7);

/** Charges one business for one finished month. Running it again for the same month changes nothing. */
export async function chargeManagementForTenant(db: ActivationDb, tenantId: number, month: Date, now: Date): Promise<ManagementChargeResult> {
  const period = periodOf(month);
  if (monthStart(month, 1) > now) throw new Error("Only a finished month can be charged");
  return db.transaction(async (tx) => {
    const pot = rowsOf<{ tenant_id: string }>(await tx.execute(sql`SELECT tenant_id FROM tenant_credit_balances WHERE tenant_id = ${tenantId} FOR UPDATE`))[0];
    const wallets = rowsOf<{ credit_plan: Plan; created_at: string; confirmed_at: string | null; management_paid_until: string | null; deleted_at: string | null }>(await tx.execute(sql`
      SELECT credit_plan, created_at, confirmed_at, management_paid_until, deleted_at FROM wallet_activations
      WHERE tenant_id = ${tenantId} AND state = 'confirmed' AND credit_plan IS NOT NULL`)).map((w): ManagedWallet => ({
      plan: w.credit_plan,
      activatedAt: new Date(w.confirmed_at ?? w.created_at),
      paidUntil: w.management_paid_until ? new Date(w.management_paid_until) : null,
      deletedAt: w.deleted_at ? new Date(w.deleted_at) : null,
    }));
    const { billableWallets, amount } = monthlyManagementCharge(wallets, month);
    if (!pot || billableWallets === 0) return { tenantId, period, billableWallets, amount, charged: false };
    const inserted = rowsOf<{ id: string }>(await tx.execute(sql`
      INSERT INTO credit_ledger (tenant_id, event, management_delta_xlm, fee_xlm, reference, idempotency_key, created_by)
      VALUES (${tenantId}, 'management_charge', (0 - ${amount}::numeric), ${amount}::numeric, ${`${billableWallets} wallets in ${period}`}, ${`management:${period}`}, 'monthly-job')
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`))[0];
    if (!inserted) return { tenantId, period, billableWallets, amount, charged: false };
    await tx.execute(sql`UPDATE tenant_credit_balances SET management_xlm = management_xlm - ${amount}::numeric, updated_at = ${now.toISOString()}::timestamptz WHERE tenant_id = ${tenantId}`);
    return { tenantId, period, billableWallets, amount, charged: true };
  });
}

/** Charges every active business with a credit account for the month that ended most recently. */
export async function chargeManagementAllTenants(db: ActivationDb, now: Date): Promise<ManagementChargeResult[]> {
  const lastMonth = monthStart(now, -1);
  const tenants = rowsOf<{ id: string }>(await db.execute(sql`
    SELECT t.id FROM tenants t JOIN tenant_credit_balances b ON b.tenant_id = t.id WHERE t.is_active = true ORDER BY t.id`));
  const results: ManagementChargeResult[] = [];
  for (const t of tenants) results.push(await chargeManagementForTenant(db, Number(t.id), lastMonth, now));
  return results;
}
