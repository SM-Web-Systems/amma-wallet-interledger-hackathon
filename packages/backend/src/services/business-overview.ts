/**
 * The self-serve business page (BUSINESS_PAGE=on, testnet only): what one business can see about its own account.
 *
 * Read only. Every query is scoped to the one tenant the caller's API key belongs to. The business wallet's sealed secret is
 * never selected. Deposits go to the business's own wallet address, so no memo is needed; a payment is credited only when it
 * equals exactly one bundle's price (see credit-plans.matchDeposit), so the page lists the exact amount to send for each bundle.
 */
import { sql } from "drizzle-orm";
import { rowsOf, type Executor } from "../modules/activation/errors";
import { depositQuote, fromStroops, toStroops, type Plan } from "./credit-plans";
import type { StellarNetwork } from "./business-wallets";

export const OVERVIEW_LIMIT = 50;

export interface BusinessOverview {
  network: StellarNetwork;
  depositAddress: string | null;
  memo: null;
  firstDeposit: boolean;
  /** False when the business is suspended or inactive: no deposit instructions are given then. */
  accountActive: boolean;
  credits: { annualCredits: number; monthlyCredits: number; fundingXlm: string; managementXlm: string; registrationFeeWaived: boolean };
  /** The exact XLM to send for each active bundle. Any other amount is held for review. Bundles that share a price are left out (that amount would be held). */
  bundles: { slug: string; name: string; plan: Plan; users: number; sendXlm: string }[];
  deposits: {
    id: number; receivedAt: string; amountXlm: string; state: "credited" | "held" | "resolved"; heldReason: string | null;
    bundleSlug: string | null; plan: Plan | null; users: number | null; feeDueXlm: string; txHash: string;
  }[];
  /** Fees charged (on credited deposits plus monthly management charges) and where their payment to Amma stands. */
  fees: { onDepositsXlm: string; managementXlm: string; chargedXlm: string; paidXlm: string; pendingXlm: string; failedXlm: string };
  purchases: { id: number; purchasedAt: string; bundleSlug: string; bundleName: string; amountXlm: string; users: number | null }[];
}

const xlm = (v: unknown): string => fromStroops(toStroops(String(v ?? "0")));
const isoOf = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

export async function getBusinessOverview(db: Executor, tenantId: number, network: StellarNetwork): Promise<BusinessOverview> {
  const q = async <T,>(query: ReturnType<typeof sql>) => rowsOf<T>(await db.execute(query));

  const [tenant] = await q<{ is_active: boolean; suspended_at: string | null }>(sql`SELECT is_active, suspended_at FROM tenants WHERE id = ${tenantId}`);
  const accountActive = Boolean(tenant?.is_active) && !tenant?.suspended_at;
  const [wallet] = await q<{ address: string }>(sql`
    SELECT address FROM business_wallets WHERE tenant_id = ${tenantId} AND network = ${network} AND retired_at IS NULL LIMIT 1`);
  const [pots] = await q<{ annual_credits: number; monthly_credits: number; funding_xlm: string; management_xlm: string; registration_fee_waived: boolean }>(sql`
    SELECT annual_credits, monthly_credits, funding_xlm::text AS funding_xlm, management_xlm::text AS management_xlm, registration_fee_waived
      FROM tenant_credit_balances WHERE tenant_id = ${tenantId}`);
  const [credited] = await q<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM business_deposits WHERE tenant_id = ${tenantId} AND network = ${network} AND state = 'credited'`);
  const firstDeposit = Number(credited?.n ?? 0) === 0;
  const waived = pots?.registration_fee_waived === true;

  const catalog = await q<{ slug: string; name: string; plan: Plan; users: number }>(sql`
    SELECT slug, name, plan, users FROM bundle_catalog WHERE is_active = true AND plan IS NOT NULL AND users IS NOT NULL ORDER BY sort_order, id`);
  const priced = catalog.map((b) => ({
    slug: b.slug, name: b.name, plan: b.plan, users: Number(b.users),
    sendXlm: depositQuote(b.plan, Number(b.users), { firstDeposit, waiveRegistrationFee: waived }).depositTotal,
  }));
  // matchDeposit holds an amount that fits more than one bundle, so never tell anyone to send it.
  const bundles = accountActive ? priced.filter((b) => priced.filter((o) => o.sendXlm === b.sendXlm).length === 1) : [];

  const deposits = (await q<Record<string, unknown>>(sql`
    SELECT id, received_at, amount_xlm::text AS amount_xlm, state, held_reason, bundle_slug, plan, users, fee_due_xlm::text AS fee_due_xlm, tx_hash
      FROM business_deposits WHERE tenant_id = ${tenantId} AND network = ${network}
     ORDER BY received_at DESC, id DESC LIMIT ${OVERVIEW_LIMIT}`)).map((d) => ({
    id: Number(d.id), receivedAt: isoOf(d.received_at), amountXlm: xlm(d.amount_xlm), state: d.state as "credited" | "held" | "resolved",
    heldReason: (d.held_reason as string | null) ?? null, bundleSlug: (d.bundle_slug as string | null) ?? null, plan: (d.plan as Plan | null) ?? null,
    users: d.users === null || d.users === undefined ? null : Number(d.users), feeDueXlm: xlm(d.fee_due_xlm), txHash: String(d.tx_hash),
  }));

  const [due] = await q<{ v: string }>(sql`
    SELECT coalesce(sum(fee_due_xlm), 0)::text AS v FROM business_deposits WHERE tenant_id = ${tenantId} AND network = ${network} AND state = 'credited'`);
  const [mgmt] = await q<{ v: string }>(sql`
    SELECT coalesce(sum(fee_xlm), 0)::text AS v FROM credit_ledger WHERE tenant_id = ${tenantId} AND event = 'management_charge'`);
  const [sweeps] = await q<{ paid: string; pending: string; failed: string }>(sql`
    SELECT coalesce(sum(amount_xlm) FILTER (WHERE state = 'confirmed'), 0)::text AS paid,
           coalesce(sum(amount_xlm) FILTER (WHERE state IN ('pending','submitting','submitted')), 0)::text AS pending,
           coalesce(sum(amount_xlm) FILTER (WHERE state = 'failed'), 0)::text AS failed
      FROM fee_sweeps WHERE tenant_id = ${tenantId} AND network = ${network}`);

  const purchases = (await q<Record<string, unknown>>(sql`
    SELECT p.id, p.purchased_at, p.bundle_slug_snapshot, p.bundle_name_snapshot, p.amount_xlm::text AS amount_xlm, p.approx_users_snapshot
      FROM tenant_bundle_purchases p
     WHERE p.tenant_id = ${tenantId}
       AND EXISTS (SELECT 1 FROM business_deposits d WHERE d.bundle_purchase_id = p.id AND d.tenant_id = ${tenantId} AND d.network = ${network})
     ORDER BY p.purchased_at DESC, p.id DESC LIMIT ${OVERVIEW_LIMIT}`)).map((p) => ({
    id: Number(p.id), purchasedAt: isoOf(p.purchased_at), bundleSlug: String(p.bundle_slug_snapshot), bundleName: String(p.bundle_name_snapshot),
    amountXlm: xlm(p.amount_xlm), users: p.approx_users_snapshot === null || p.approx_users_snapshot === undefined ? null : Number(p.approx_users_snapshot),
  }));

  return {
    network,
    depositAddress: accountActive ? wallet?.address ?? null : null,
    memo: null,
    firstDeposit,
    accountActive,
    credits: {
      annualCredits: Number(pots?.annual_credits ?? 0), monthlyCredits: Number(pots?.monthly_credits ?? 0),
      fundingXlm: xlm(pots?.funding_xlm), managementXlm: xlm(pots?.management_xlm), registrationFeeWaived: waived,
    },
    bundles,
    deposits,
    fees: {
      onDepositsXlm: xlm(due?.v), managementXlm: xlm(mgmt?.v),
      chargedXlm: fromStroops(toStroops(xlm(due?.v)) + toStroops(xlm(mgmt?.v))),
      paidXlm: xlm(sweeps?.paid), pendingXlm: xlm(sweeps?.pending), failedXlm: xlm(sweeps?.failed),
    },
    purchases,
  };
}
