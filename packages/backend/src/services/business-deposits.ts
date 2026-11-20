/**
 * Business deposits (BUSINESS_DEPOSITS=on; owner decisions of 16 Nov 2026).
 *
 * The watcher reads the XLM payments into each business wallet from Horizon, oldest first, from where it last stopped.
 * Horizon only serves closed ledgers, which are final on Stellar, so nothing waits for confirmations.
 *
 * A payment that equals exactly one bundle price (on the first deposit: plus the 1 XLM reserve and, unless waived, the 100 XLM
 * registration fee) is credited at once: credits and pots, a credit_ledger row, and a bundle purchase row as the receipt. The
 * amount owed to the business's hardware fee address is recorded on the deposit for the fee sweep. Anything else is held and
 * emailed to the owner; nothing is credited for it until someone resolves it by hand.
 *
 * Each payment is handled once (unique per network and Horizon operation id), in one transaction with the cursor.
 */
import { sql } from "drizzle-orm";
import { appLog } from "../lib/app-log";
import type { AuditAction } from "../lib/audit";
import { iso, rowsOf, type ActivationDb } from "../modules/activation/errors";
import { fromStroops, matchDeposit, toStroops, type CatalogBundle, type Plan } from "./credit-plans";
import { assignFeeAddress, type StellarNetwork } from "./business-wallets";

/** The fields of a Horizon payments record that the watcher reads. */
export interface HorizonPayment {
  id: string;
  paging_token: string;
  type: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  created_at: string;
  asset_type?: string;
  from?: string;
  to?: string;
  amount?: string;
  funder?: string;
  account?: string;
  starting_balance?: string;
}

export interface PaymentFeed {
  /** Payments touching the address after the cursor, oldest first. A missing account gives an empty list. */
  payments(address: string, cursor: string | null, limit: number): Promise<HorizonPayment[]>;
}

interface HorizonPaymentsServer {
  payments(): { forAccount(a: string): { cursor(c: string): any; order(o: "asc"): any } };
}

export function horizonPaymentFeed(server: HorizonPaymentsServer): PaymentFeed {
  return {
    async payments(address, cursor, limit) {
      try {
        const page = await server.payments().forAccount(address).cursor(cursor ?? "0").order("asc").limit(limit).call();
        return page.records as HorizonPayment[];
      } catch (e: any) {
        if (e?.response?.status === 404 || e?.name === "NotFoundError") return [];
        throw e;
      }
    },
  };
}

const AMOUNT = /^\d{1,12}(\.\d{1,7})?$/;
const HASH = /^[0-9a-f]{64}$/;
const OP = /^\d{1,30}$/;

/** An incoming XLM amount for this wallet, or null for anything else (outgoing, other assets, failed, unknown types). */
export function incomingXlm(record: HorizonPayment, wallet: string): { from: string; amount: string } | null {
  if (record.transaction_successful === false) return null;
  if (!OP.test(record.id) || !OP.test(record.paging_token) || !HASH.test(record.transaction_hash)) return null;
  let from: string | undefined, amount: string | undefined;
  if (record.type === "create_account" && record.account === wallet) { from = record.funder; amount = record.starting_balance; }
  else if (["payment", "path_payment_strict_receive", "path_payment_strict_send"].includes(record.type) && record.to === wallet && record.asset_type === "native") { from = record.from; amount = record.amount; }
  if (!from || !amount || from === wallet || !AMOUNT.test(amount) || toStroops(amount) <= 0n) return null;
  return { from, amount };
}

const auditInTx = async (tx: Pick<ActivationDb, "execute">, action: AuditAction, detail: Record<string, unknown>) =>
  tx.execute(sql`INSERT INTO audit_logs (user_id, action, detail) VALUES (${null}, ${action}, ${JSON.stringify(detail)}::jsonb)`);

export type DepositOutcome =
  | { kind: "credited"; depositId: number; slug: string; plan: Plan; users: number; feeDue: string; first: boolean }
  | { kind: "held"; depositId: number; reason: string }
  | { kind: "duplicate" };

/** Credits or holds one incoming payment. Runs inside the caller's transaction. */
export async function recordDeposit(tx: Pick<ActivationDb, "execute">, input: {
  tenantId: number; network: StellarNetwork; wallet: string; record: HorizonPayment; from: string; amount: string;
}): Promise<DepositOutcome> {
  const { tenantId, network, wallet, record, from, amount } = input;
  const receivedAt = new Date(record.created_at);
  const received = Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt;
  const catalog = rowsOf<CatalogBundle & { id: string; name: string }>(await tx.execute(sql`
    SELECT id, slug, name, plan, users FROM bundle_catalog WHERE is_active = true AND plan IS NOT NULL AND users IS NOT NULL ORDER BY sort_order, id`))
    .map((b) => ({ ...b, users: Number(b.users) }));
  await tx.execute(sql`INSERT INTO tenant_credit_balances (tenant_id) VALUES (${tenantId}) ON CONFLICT (tenant_id) DO NOTHING`);
  const balance = rowsOf<{ registration_fee_waived: boolean }>(await tx.execute(sql`SELECT registration_fee_waived FROM tenant_credit_balances WHERE tenant_id = ${tenantId} FOR UPDATE`))[0];
  const first = !rowsOf(await tx.execute(sql`SELECT 1 FROM business_deposits WHERE tenant_id = ${tenantId} AND network = ${network} AND state = 'credited' LIMIT 1`)).length;
  const match = catalog.length
    ? matchDeposit(amount, catalog, { firstDeposit: first, waiveRegistrationFee: balance.registration_fee_waived })
    : { kind: "unmatched" as const, reason: "no_catalog" as const };
  const common = { tenant_id: tenantId, network, wallet, op: record.id, hash: record.transaction_hash, from, amount, at: iso(received) };

  if (match.kind !== "bundle") {
    const held = rowsOf<{ id: string }>(await tx.execute(sql`
      INSERT INTO business_deposits (tenant_id, network, wallet_address, operation_id, tx_hash, from_address, amount_xlm, received_at, state, held_reason)
      VALUES (${tenantId}, ${network}, ${wallet}, ${record.id}, ${record.transaction_hash}, ${from}, ${amount}::numeric, ${common.at}::timestamptz, 'held', ${match.reason})
      ON CONFLICT (network, operation_id) DO NOTHING RETURNING id`))[0];
    if (!held) return { kind: "duplicate" };
    await auditInTx(tx, "business_deposit_held", { tenantId, network, depositId: Number(held.id), amount, txHash: record.transaction_hash, reason: match.reason });
    return { kind: "held", depositId: Number(held.id), reason: match.reason };
  }

  const bundle = catalog.find((b) => b.slug === match.slug)!;
  const q = match.quote;
  const users = bundle.users;
  const annual = bundle.plan === "annual" ? users : 0;
  const registration = q.registrationFee;
  const feeWithoutRegistration = fromStroops(toStroops(q.toFeeAddress) - toStroops(registration));
  const key = `deposit:${network}:${record.id}`;
  const ledger = rowsOf<{ id: string }>(await tx.execute(sql`
    INSERT INTO credit_ledger (tenant_id, event, plan, annual_credits_delta, monthly_credits_delta, funding_delta_xlm, management_delta_xlm, fee_xlm, bundle_slug, reference, idempotency_key, created_by)
    VALUES (${tenantId}, 'bundle_credit', ${bundle.plan}, ${annual}, ${users - annual}, ${q.toFundingPot}::numeric, ${q.toManagementPot}::numeric, ${feeWithoutRegistration}::numeric,
      ${bundle.slug}, ${`deposit ${record.transaction_hash}`}, ${key}, 'deposit-watcher')
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`))[0];
  if (!ledger) return { kind: "duplicate" };
  if (toStroops(registration) > 0n) {
    await tx.execute(sql`INSERT INTO credit_ledger (tenant_id, event, fee_xlm, reference, idempotency_key, created_by)
      VALUES (${tenantId}, 'registration_fee', ${registration}::numeric, ${`deposit ${record.transaction_hash}`}, ${`deposit-registration:${network}:${record.id}`}, 'deposit-watcher')
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`);
  }
  await tx.execute(sql`UPDATE tenant_credit_balances SET annual_credits = annual_credits + ${annual}, monthly_credits = monthly_credits + ${users - annual},
    funding_xlm = funding_xlm + ${q.toFundingPot}::numeric, management_xlm = management_xlm + ${q.toManagementPot}::numeric,
    registration_fee_paid_at = CASE WHEN ${toStroops(registration) > 0n} THEN COALESCE(registration_fee_paid_at, ${common.at}::timestamptz) ELSE registration_fee_paid_at END,
    updated_at = now() WHERE tenant_id = ${tenantId}`);
  const receipt = rowsOf<{ id: string }>(await tx.execute(sql`
    INSERT INTO tenant_bundle_purchases (tenant_id, bundle_id, bundle_slug_snapshot, bundle_name_snapshot, amount_xlm, approx_users_snapshot, notes, purchased_at, payment_reference)
    VALUES (${tenantId}, ${Number(bundle.id)}, ${bundle.slug}, ${bundle.name}, ${amount}::numeric, ${users}, 'Paid into the business wallet; credited automatically', ${common.at}::timestamptz, ${record.transaction_hash})
    RETURNING id`))[0];
  const deposit = rowsOf<{ id: string }>(await tx.execute(sql`
    INSERT INTO business_deposits (tenant_id, network, wallet_address, operation_id, tx_hash, from_address, amount_xlm, received_at, state, bundle_slug, plan, users,
      funding_xlm, management_xlm, registration_xlm, reserve_xlm, fee_due_xlm, credit_ledger_id, bundle_purchase_id)
    VALUES (${tenantId}, ${network}, ${wallet}, ${record.id}, ${record.transaction_hash}, ${from}, ${amount}::numeric, ${common.at}::timestamptz, 'credited', ${bundle.slug}, ${bundle.plan}, ${users},
      ${q.toFundingPot}::numeric, ${q.toManagementPot}::numeric, ${registration}::numeric, ${q.reserve}::numeric, ${q.toFeeAddress}::numeric, ${Number(ledger.id)}, ${Number(receipt.id)})
    RETURNING id`))[0];
  await auditInTx(tx, "business_deposit_credited", { tenantId, network, depositId: Number(deposit.id), amount, txHash: record.transaction_hash, bundle: bundle.slug, feeDue: q.toFeeAddress, first });
  return { kind: "credited", depositId: Number(deposit.id), slug: bundle.slug, plan: bundle.plan, users, feeDue: q.toFeeAddress, first };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const REASONS: Record<string, string> = {
  no_bundle_matches_amount: "The amount doesn't match any bundle price.",
  amount_matches_more_than_one_bundle: "The amount matches more than one bundle.",
  no_catalog: "There are no active bundles to match against.",
};
const RETRY_ESCALATION_MS = 30 * 60_000;

export type Mailer = (to: string, subject: string, html: string) => Promise<boolean>;

/** Emails the owner about held deposits not yet escalated, at most every 30 minutes per deposit while mail keeps failing. */
export async function escalateHeldDeposits(db: ActivationDb, deps: { mail: Mailer; to: string; now: Date }): Promise<number> {
  const due = rowsOf<{ id: string; tenant_id: string; name: string; network: string; amount: string; tx_hash: string; from_address: string; held_reason: string; received_at: string }>(await db.execute(sql`
    SELECT d.id, d.tenant_id, t.name, d.network, d.amount_xlm::text AS amount, d.tx_hash, d.from_address, d.held_reason, d.received_at
    FROM business_deposits d JOIN tenants t ON t.id = d.tenant_id
    WHERE d.state = 'held' AND d.escalated_at IS NULL AND (d.escalation_tried_at IS NULL OR d.escalation_tried_at < ${iso(new Date(deps.now.getTime() - RETRY_ESCALATION_MS))}::timestamptz)
    ORDER BY d.id LIMIT 20`));
  let sent = 0;
  for (const d of due) {
    const subject = `Amma Wallet: deposit held for ${d.name} (${d.amount} XLM)`;
    const html = `<p>A deposit into a business wallet was <b>held</b>, not credited. Nothing has been swept or credited for it.</p>
      <ul><li>Business: ${escapeHtml(d.name)} (id ${escapeHtml(String(d.tenant_id))})</li><li>Network: ${escapeHtml(d.network)}</li>
      <li>Amount: ${escapeHtml(d.amount)} XLM</li><li>From: ${escapeHtml(d.from_address)}</li><li>Transaction: ${escapeHtml(d.tx_hash)}</li>
      <li>Why: ${escapeHtml(REASONS[d.held_reason] ?? d.held_reason)}</li></ul><p>Please resolve it by hand: credit a bundle, or arrange a return with the business.</p>`;
    let ok = false;
    try { ok = await deps.mail(deps.to, subject, html); } catch { ok = false; }
    await db.execute(sql`UPDATE business_deposits SET escalation_tried_at = ${iso(deps.now)}::timestamptz, escalated_at = ${ok ? iso(deps.now) : null}::timestamptz WHERE id = ${Number(d.id)}`);
    await db.execute(sql`INSERT INTO tenant_alert_log (tenant_id, alert_type, threshold, sent_to, delivered, error) VALUES (${Number(d.tenant_id)}, 'unallocated_deposit', ${d.amount}::numeric, 'owner', ${ok}, ${ok ? null : "send_failed"})`);
    if (ok) sent++; else appLog().error({ depositId: Number(d.id) }, "business_deposit_escalation_failed");
  }
  return sent;
}

export interface ScanResult { wallets: number; credited: number; held: number; skipped: number; failedWallets: number }
const PAGE = 50;
const MAX_PAGES = 10;

/**
 * One pass over every live business wallet on this network. A Horizon failure on one wallet is logged and the others go on;
 * its cursor stays where it was, so nothing is skipped. Then held deposits are escalated.
 */
export async function scanBusinessDeposits(db: ActivationDb, deps: { feed: PaymentFeed; network: StellarNetwork; now: () => Date; mail: Mailer; escalateTo: string }): Promise<ScanResult> {
  const result: ScanResult = { wallets: 0, credited: 0, held: 0, skipped: 0, failedWallets: 0 };
  const wallets = rowsOf<{ id: string; tenant_id: string; address: string; deposit_cursor: string | null }>(await db.execute(sql`
    SELECT id, tenant_id, address, deposit_cursor FROM business_wallets WHERE network = ${deps.network} AND retired_at IS NULL ORDER BY id`));
  for (const w of wallets) {
    result.wallets++;
    let cursor = w.deposit_cursor;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const records = await deps.feed.payments(w.address, cursor, PAGE);
        for (const record of records) {
          if (!OP.test(record.paging_token)) throw new Error("bad paging token");
          const outcome = await db.transaction(async (tx) => {
            // The cursor moves in the same transaction as the deposit, and only forward from where this pass read it.
            const moved = rowsOf(await tx.execute(sql`UPDATE business_wallets SET deposit_cursor = ${record.paging_token}
              WHERE id = ${Number(w.id)} AND deposit_cursor IS NOT DISTINCT FROM ${cursor} RETURNING id`));
            if (!moved.length) throw new Error("cursor moved");
            const incoming = incomingXlm(record, w.address);
            if (!incoming) return null;
            return recordDeposit(tx, { tenantId: Number(w.tenant_id), network: deps.network, wallet: w.address, record, ...incoming });
          });
          cursor = record.paging_token;
          if (!outcome || outcome.kind === "duplicate") { result.skipped++; continue; }
          if (outcome.kind === "held") { result.held++; continue; }
          result.credited++;
          appLog().info({ tenantId: Number(w.tenant_id), depositId: outcome.depositId, bundle: outcome.slug }, "business_deposit_credited");
          if (outcome.first) {
            // The business has funded its account: give it its hardware fee address now. The sweep retries if this fails.
            try { await assignFeeAddress(db, { tenantId: Number(w.tenant_id), network: deps.network, now: deps.now(), by: "deposit-watcher" }); }
            catch { appLog().error({ tenantId: Number(w.tenant_id) }, "fee_address_unassigned"); }
          }
        }
        if (records.length < PAGE) break;
      }
    } catch {
      result.failedWallets++;
      appLog().warn({ tenantId: Number(w.tenant_id) }, "business_deposit_scan_failed");
    }
  }
  await escalateHeldDeposits(db, { mail: deps.mail, to: deps.escalateTo, now: deps.now() });
  return result;
}

/** Runs the scan on an interval under a single-runner lock, without overlapping. Returns a stop function. */
export function startBusinessDepositWatcher(run: () => Promise<unknown>, lock: () => Promise<null | (() => Promise<void>)>, everyMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    let release: null | (() => Promise<void>) = null;
    try {
      release = await lock();
      if (release) await run();
    } catch { appLog().error({}, "business_deposit_tick_failed"); }
    finally {
      running = false;
      if (release) await release().catch(() => undefined);
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
