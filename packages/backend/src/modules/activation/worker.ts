import { sql } from "drizzle-orm";
import { appLog } from "../../lib/app-log";
import type { ActivationFlags } from "../../lib/activation-flags";
import type { AuditAction } from "../../lib/audit";
import { iso, rowsOf, stroopsToXlm, type ActivationDb } from "./errors";
import { auditInTx } from "./intake";
import type { StellarRail } from "./stellar-rail";

/**
 * Stellar activation worker. Order of events for one row, each step committed before the next:
 *   reserved -> submitting (claimed, attempt counted) -> hash stored -> submit -> submitted -> confirmed
 * A failure that is certain (Horizon refused it, it failed on the ledger, or Horizon has ingested past its time bounds
 * without it) ends the attempt: the row waits out a backoff and is tried again, up to 3 attempts, then it is refunded.
 * An outcome that is not certain (timeout, 5xx, Horizon lagging) leaves the row `submitted` with its hash; it is only ever
 * looked up, never sent again, until the transaction can no longer be included.
 * Every hash ever built for a row stays in tx_hashes. Before any skip, failure or refund, all of them are looked up: a
 * transaction that landed late is confirmed, never refunded.
 */
const MAX_ATTEMPTS = 3;
const DEAD_GRACE_SECONDS = 30; // past maxTime a transaction can never be included; this covers clock skew
const STALE_SUBMITTING_MS = 2 * 60_000; // claimed but no transaction built: nothing was ever broadcast

/** Returns a release function when this process now holds the single-runner lock, or null when another runner has it. */
export type SessionLock = () => Promise<null | (() => Promise<void>)>;

export interface WorkerOptions {
  db: ActivationDb; rail: StellarRail; flags: ActivationFlags; paused: () => boolean; sessionLock: SessionLock; now?: () => Date; batch?: number;
  /**
   * BUSINESS_WALLETS=on: the rail that pays a business's credit activations from its own wallet, or null when it has none.
   * Lookups and ledger times stay on the shared rail; they ask Horizon about the network, not about one wallet.
   */
  businessRail?: (tenantId: number) => Promise<StellarRail | null>;
}
export interface TickResult { ran: boolean; confirmed: number; failed: number; skipped: number }

/** A short code for a log line or a row. Never the message, which can carry URLs, bodies or keys. */
export function codeOf(e: unknown): string {
  const status = (e as any)?.response?.status ?? (e as any)?.status;
  if ((e as any)?.name === "TimeoutError" || (e as any)?.name === "AbortError" || (e as any)?.code === "ECONNABORTED" || status === 504) return "timeout";
  return typeof status === "number" ? `horizon-${status}` : "horizon-unavailable";
}

/**
 * A session-level advisory lock on one dedicated connection, held for the whole tick. A pooled connection cannot be used:
 * the lock would stay with whichever connection ran the query. `client` is a postgres-js client.
 */
export function postgresSessionLock(client: { reserve(): Promise<any> }, which: "activation" | "business-deposits" | "fee-sweeps" | "business-floor" = "activation"): SessionLock {
  // Literal keys: 13 is the activation worker, 15 the business deposit watcher, 17 the fee sweeper, 20 the business floor check.
  const take = (conn: any) => which === "activation" ? conn`SELECT pg_try_advisory_lock(731241, 13) AS locked`
    : which === "business-deposits" ? conn`SELECT pg_try_advisory_lock(731241, 15) AS locked`
    : which === "fee-sweeps" ? conn`SELECT pg_try_advisory_lock(731241, 17) AS locked` : conn`SELECT pg_try_advisory_lock(731241, 20) AS locked`;
  const drop = (conn: any) => which === "activation" ? conn`SELECT pg_advisory_unlock(731241, 13)`
    : which === "business-deposits" ? conn`SELECT pg_advisory_unlock(731241, 15)`
    : which === "fee-sweeps" ? conn`SELECT pg_advisory_unlock(731241, 17)` : conn`SELECT pg_advisory_unlock(731241, 20)`;
  return async () => {
    const conn = await client.reserve();
    try {
      const [row] = await take(conn);
      if (!row?.locked) { conn.release(); return null; }
      return async () => { try { await drop(conn); } finally { conn.release(); } };
    } catch (e) { conn.release(); throw e; }
  };
}

type Row = { id: string; tenant_id: string; user_id: number; completion_id: string; address: string; grant_base_units: string; attempts: number; tx_hash: string | null; tx_hashes: string[] | null; deadline: string | null; state: string; billing_event_id: string | null; credit_plan?: "monthly" | "annual" | null };
const BASE_COLUMNS = "id, tenant_id, user_id, completion_id, address, grant_base_units, attempts, tx_hash, tx_hashes, deadline, state, billing_event_id";
// credit_plan exists only once credits-v1 is applied, which BUSINESS_CREDITS=on requires (schema gate).
const columnsFor = (flags: ActivationFlags) => sql.raw(flags.businessCredits ? `${BASE_COLUMNS}, credit_plan` : BASE_COLUMNS);

export class ActivationWorker {
  private readonly now: () => Date;
  private running = false;
  constructor(private readonly o: WorkerOptions) { this.now = o.now ?? (() => new Date()); }

  async tick(): Promise<TickResult> {
    const result: TickResult = { ran: false, confirmed: 0, failed: 0, skipped: 0 };
    if (!this.o.flags.enabled || this.running || this.o.paused()) return result;
    this.running = true;
    let release: null | (() => Promise<void>) = null;
    try {
      release = await this.o.sessionLock();
      if (!release) return result; // another runner holds the lock
      result.ran = true;
      await this.recover(result);
      await this.send(result);
    } finally {
      this.running = false;
      if (release) await release().catch(() => appLog().error({ code: "unlock_failed" }, "activation_unlock_failed"));
    }
    return result;
  }

  // ── rows whose outcome is unknown ───────────────────────────────────────────────────────────
  private async recover(result: TickResult) {
    const { db, flags, rail } = this.o;
    const now = this.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const rows = rowsOf<Row>(await db.execute(sql`SELECT ${columnsFor(flags)} FROM wallet_activations
      WHERE chain = 'stellar' AND network = ${flags.network} AND state IN ('submitting','submitted') ORDER BY id LIMIT 20`));
    let ledgerClosed: number | undefined | null; // undefined: not asked yet; null: Horizon could not say
    for (const row of rows) {
      if (this.o.paused()) return;
      if (!row.tx_hash || !row.deadline) {
        // Claimed, but no transaction was ever built, so nothing can have been sent. Hand it back once it is clearly abandoned.
        await db.execute(sql`UPDATE wallet_activations SET state = 'reserved', attempts = GREATEST(attempts - 1, 0), updated_at = ${iso(now)}::timestamptz
          WHERE id = ${Number(row.id)} AND state = 'submitting' AND deadline IS NULL AND updated_at < ${iso(new Date(now.getTime() - STALE_SUBMITTING_MS))}::timestamptz`);
        continue;
      }
      let verdict: "missing" | "success" | "failed";
      try { verdict = await rail.lookup(row.tx_hash); } catch (e) { appLog().warn({ activationId: Number(row.id), code: codeOf(e) }, "activation_lookup_failed"); continue; }
      if (verdict === "success") await this.confirm(row, result);
      else if (verdict === "failed") await this.fail(row, "tx-failed", result);
      else if (nowSeconds > Number(row.deadline) + DEAD_GRACE_SECONDS) {
        // The wall clock is not proof: Horizon can lag. Dead only when Horizon itself has ingested past the time bounds.
        if (ledgerClosed === undefined) { try { ledgerClosed = await rail.ledgerClosedAt(); } catch (e) { ledgerClosed = null; appLog().warn({ code: codeOf(e) }, "activation_ledger_unreadable"); } }
        if (ledgerClosed !== null && ledgerClosed > Number(row.deadline) + DEAD_GRACE_SECONDS) await this.fail(row, "expired", result);
      }
    }
  }

  // ── new work ────────────────────────────────────────────────────────────────────────────────
  private async send(result: TickResult) {
    const { flags } = this.o;
    const batch = this.o.batch ?? 5;
    // Who pays the waiting rows: the shared treasury (payer null), or, with business wallets on, each business for its credit rows.
    const payers = rowsOf<{ payer: string | null }>(await this.o.db.execute(flags.businessWallets
      ? sql`SELECT DISTINCT CASE WHEN credit_plan IS NULL THEN NULL ELSE tenant_id END AS payer FROM wallet_activations WHERE chain = 'stellar' AND network = ${flags.network} AND state IN ('reserved','failed') AND attempts < ${MAX_ATTEMPTS}`
      : sql`SELECT NULL AS payer FROM wallet_activations WHERE chain = 'stellar' AND network = ${flags.network} AND state IN ('reserved','failed') AND attempts < ${MAX_ATTEMPTS} LIMIT 1`));
    if (!payers.length) return;
    // Each payer's balance is checked once; a payer that cannot pay is left out of this tick and its rows wait untouched.
    const rails = new Map<number | null, StellarRail>();
    for (const { payer } of payers) {
      const tenantId = payer === null ? null : Number(payer);
      const rail = await this.payerRail(tenantId);
      if (rail && await this.canPay(rail, tenantId)) rails.set(tenantId, rail);
    }
    if (!rails.size) return;
    for (let i = 0; i < batch; i++) {
      if (this.o.paused()) return;
      const row = await this.claim(rails);
      if (!row) return;
      const rail = rails.get(flags.businessWallets && row.credit_plan ? Number(row.tenant_id) : null)!;
      if ((await this.attempt(row, result, rail)) === "stop") return; // Horizon is struggling: wait for the next tick
    }
  }

  private async payerRail(tenantId: number | null): Promise<StellarRail | null> {
    if (tenantId === null) return this.o.rail;
    if (!this.o.businessRail) { appLog().error({ tenantId }, "activation_business_rail_missing"); return null; }
    try {
      const rail = await this.o.businessRail(tenantId);
      if (!rail) appLog().error({ tenantId }, "activation_business_wallet_missing");
      return rail;
    } catch { appLog().error({ tenantId }, "activation_business_wallet_unavailable"); return null; }
  }

  /** The same floor for every payer: refuse below two grants, warn below twenty. The log line names the business, never a key. */
  private async canPay(rail: StellarRail, tenantId: number | null): Promise<boolean> {
    const { flags } = this.o;
    const who = tenantId === null ? {} : { tenantId };
    const prefix = tenantId === null ? "activation_treasury" : "activation_business_wallet";
    let balance: bigint;
    try { balance = await rail.treasuryStroops(); } catch (e) { appLog().error({ ...who, code: codeOf(e) }, `${prefix}_unreadable`); return false; }
    if (balance < flags.stellarGrantStroops * 2n) { appLog().error({ ...who, balanceStroops: balance.toString() }, `${prefix}_refused`); return false; }
    if (balance < flags.stellarGrantStroops * 20n) appLog().warn({ ...who, balanceStroops: balance.toString() }, `${prefix}_low`);
    return true;
  }

  /** One atomic UPDATE: the state change plus SKIP LOCKED make a row single-owner. Earlier hashes are kept. Only rows a usable payer covers. */
  private async claim(rails: Map<number | null, StellarRail>): Promise<Row | undefined> {
    const now = this.now();
    const { flags } = this.o;
    const tenants = [...rails.keys()].filter((k): k is number => k !== null).join(",");
    const payable = flags.businessWallets
      ? sql`AND ((credit_plan IS NULL AND ${rails.has(null)}) OR (credit_plan IS NOT NULL AND tenant_id = ANY(string_to_array(${tenants}, ',')::bigint[])))`
      : sql``;
    return rowsOf<Row>(await this.o.db.execute(sql`
      UPDATE wallet_activations SET state = 'submitting', attempts = attempts + 1, error_code = NULL, deadline = NULL, updated_at = ${iso(now)}::timestamptz
      WHERE id = (SELECT id FROM wallet_activations WHERE chain = 'stellar' AND network = ${flags.network} AND attempts < ${MAX_ATTEMPTS}
        AND (state = 'reserved' OR (state = 'failed' AND updated_at <= ${iso(now)}::timestamptz - (CASE WHEN attempts <= 1 THEN interval '60 seconds' ELSE interval '300 seconds' END)))
        ${payable}
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING ${columnsFor(flags)}`))[0];
  }

  private async attempt(row: Row, result: TickResult, rail: StellarRail): Promise<"stop" | void> {
    const { db } = this.o;
    const id = Number(row.id);
    const release = async (code: string): Promise<"stop"> => {
      // Nothing was built or sent: give the attempt back so a Horizon outage does not use up a user's three tries.
      appLog().warn({ activationId: id, code }, "activation_not_sent");
      await db.execute(sql`UPDATE wallet_activations SET state = 'reserved', attempts = GREATEST(attempts - 1, 0), updated_at = ${iso(this.now())}::timestamptz WHERE id = ${id} AND state = 'submitting' AND deadline IS NULL`);
      return "stop";
    };
    let existing;
    try { existing = await rail.account(row.address); } catch (e) { return release(codeOf(e)); }
    if (existing.exists) return this.skip(row, result);
    let built;
    try { built = await rail.build(row.address, BigInt(row.grant_base_units), Math.floor(this.now().getTime() / 1000)); } catch (e) { return release(codeOf(e)); }
    // Write-ahead: the hash is committed (and appended to the history) before the transaction leaves this process.
    // source_address (business-wallets-v1) records which wallet paid, for reconciliation.
    const source = this.o.flags.businessWallets ? sql`, source_address = ${rail.treasuryAddress}` : sql``;
    const stored = rowsOf(await db.execute(sql`UPDATE wallet_activations SET tx_hash = ${built.hash}, tx_hashes = array_append(tx_hashes, ${built.hash}), deadline = ${String(built.maxTime)}, updated_at = ${iso(this.now())}::timestamptz${source}
      WHERE id = ${id} AND state = 'submitting' AND deadline IS NULL RETURNING id`));
    if (!stored.length) return;
    const stamped = { ...row, tx_hash: built.hash, tx_hashes: [...(row.tx_hashes ?? []), built.hash], deadline: String(built.maxTime) };
    let outcome;
    try { outcome = await rail.submit(built.envelope); }
    catch (e) {
      // Unknown outcome: it may have landed. Keep the hash and look it up; never send again before it is provably dead.
      appLog().warn({ activationId: id, code: codeOf(e) }, "activation_submit_unknown");
      await db.execute(sql`UPDATE wallet_activations SET state = 'submitted', updated_at = ${iso(this.now())}::timestamptz WHERE id = ${id} AND state = 'submitting'`);
      return;
    }
    if (!outcome.accepted) {
      if (outcome.code === "already-exists") return this.skip(stamped, result);
      return this.fail(stamped, outcome.code, result);
    }
    await db.execute(sql`UPDATE wallet_activations SET state = 'submitted', updated_at = ${iso(this.now())}::timestamptz WHERE id = ${id} AND state = 'submitting'`);
    try { if ((await rail.lookup(built.hash)) === "success") await this.confirm(stamped, result); } catch { /* confirmed on a later tick */ }
  }

  /**
   * Did any transaction ever built for this row land? Asked before every skip, failure and refund.
   * A hash if one did; "unknown" when Horizon could not answer for one of them (nothing may be concluded); null if none did.
   */
  private async priorLanded(row: Row): Promise<string | "unknown" | null> {
    const fresh = rowsOf<{ tx_hashes: string[] | null }>(await this.o.db.execute(sql`SELECT tx_hashes FROM wallet_activations WHERE id = ${Number(row.id)}`))[0];
    const hashes = [...new Set([...(fresh?.tx_hashes ?? []), ...(row.tx_hashes ?? []), ...(row.tx_hash ? [row.tx_hash] : [])])];
    let unknown = false;
    for (const hash of hashes) {
      try { if ((await this.o.rail.lookup(hash)) === "success") return hash; }
      catch (e) { unknown = true; appLog().warn({ activationId: Number(row.id), code: codeOf(e) }, "activation_lookup_failed"); }
    }
    return unknown ? "unknown" : null;
  }

  // ── terminal moves, each with its audit row (and refund) in one transaction ──────────────────
  private async confirm(row: Row, result: TickResult, hash?: string) {
    const now = this.now();
    const landed = hash ?? row.tx_hash;
    await this.o.db.transaction(async (tx) => {
      const moved = rowsOf(await tx.execute(sql`UPDATE wallet_activations SET state = 'confirmed', tx_hash = ${landed}, confirmed_at = ${iso(now)}::timestamptz, updated_at = ${iso(now)}::timestamptz, error_code = NULL
        WHERE id = ${Number(row.id)} AND state IN ('submitting','submitted','failed') RETURNING id`));
      if (!moved.length) return;
      await auditInTx(tx, "activation_funded", row.user_id, { activationId: Number(row.id), chain: "stellar", address: row.address, amount: stroopsToXlm(BigInt(row.grant_base_units)), txHash: landed });
      result.confirmed++;
    });
    appLog().info({ activationId: Number(row.id), chain: "stellar" }, "activation_funded");
  }

  private async skip(row: Row, result: TickResult) {
    const prior = await this.priorLanded(row);
    if (prior === "unknown") return; // cannot rule out that our own transaction created it: do not refund yet
    if (prior) return this.confirm(row, result, prior);
    await this.finish(row, "skipped_already_active", "already-exists", ["activation_refunded"]);
    result.skipped++;
  }

  /** A failed attempt. Another attempt is made after a backoff, or, with none left, the partner is refunded. */
  private async fail(row: Row, code: string, result: TickResult) {
    const prior = await this.priorLanded(row);
    if (prior === "unknown") return;
    if (prior) return this.confirm(row, result, prior);
    if (row.attempts >= MAX_ATTEMPTS) {
      appLog().error({ activationId: Number(row.id), code }, "activation_failed_final");
      await this.finish(row, row.billing_event_id || row.credit_plan ? "refunded" : "failed_final", code, ["activation_failed", "activation_refunded"]);
      result.failed++;
      return;
    }
    await this.o.db.execute(sql`UPDATE wallet_activations SET state = 'failed', error_code = ${code}, updated_at = ${iso(this.now())}::timestamptz WHERE id = ${Number(row.id)} AND state IN ('submitting','submitted')`);
  }

  private async finish(row: Row, state: "skipped_already_active" | "refunded" | "failed_final", code: string, actions: AuditAction[]) {
    const now = this.now();
    await this.o.db.transaction(async (tx) => {
      const locked = rowsOf<{ state: string; billing_event_id: string | null; refund_billing_event_id: string | null; tenant_id: string }>(await tx.execute(sql`
        SELECT state, billing_event_id, refund_billing_event_id, tenant_id FROM wallet_activations WHERE id = ${Number(row.id)} FOR UPDATE`))[0];
      if (!locked || !["submitting", "submitted", "failed"].includes(locked.state)) return; // someone else finished it
      let refundId: number | null = null;
      if (locked.billing_event_id && !locked.refund_billing_event_id) {
        const key = `activation-refund:${row.id}`;
        const paid = rowsOf<{ amount_xlm: string }>(await tx.execute(sql`SELECT amount_xlm FROM billing_events WHERE id = ${Number(locked.billing_event_id)}`))[0];
        if (paid) {
          const inserted = rowsOf<{ id: string }>(await tx.execute(sql`
            INSERT INTO billing_events (tenant_id, event_type, amount_xlm, user_id, notes, created_by, idempotency_key)
            VALUES (${Number(locked.tenant_id)}, 'stellar_tx_refund', (0 - ${paid.amount_xlm}::numeric), ${row.user_id}, ${`activation ${row.id} refund`}, 'activation', ${key})
            ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`))[0];
          if (inserted) {
            await tx.execute(sql`UPDATE tenants SET prepaid_xlm_balance = prepaid_xlm_balance + (0 - ${paid.amount_xlm}::numeric), updated_at = ${iso(now)}::timestamptz WHERE id = ${Number(locked.tenant_id)}`);
            refundId = Number(inserted.id);
          }
        }
      }
      // A business credit drawn for this wallet goes back with its 1.1 XLM of funding, once (the ledger key is unique per business).
      let creditReturned = false;
      if (this.o.flags.businessCredits && row.credit_plan) {
        const funding = stroopsToXlm(BigInt(row.grant_base_units));
        const annual = row.credit_plan === "annual" ? 1 : 0;
        const returned = rowsOf<{ id: string }>(await tx.execute(sql`
          INSERT INTO credit_ledger (tenant_id, event, plan, annual_credits_delta, monthly_credits_delta, funding_delta_xlm, reference, idempotency_key, created_by)
          VALUES (${Number(locked.tenant_id)}, 'activation_refund', ${row.credit_plan}, ${annual}, ${1 - annual}, ${funding}::numeric, ${`activation ${row.id}`}, ${`activation-refund:${row.id}`}, 'activation')
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`))[0];
        if (returned) {
          await tx.execute(sql`UPDATE tenant_credit_balances SET annual_credits = annual_credits + ${annual}, monthly_credits = monthly_credits + ${1 - annual},
            funding_xlm = funding_xlm + ${funding}::numeric, updated_at = ${iso(now)}::timestamptz WHERE tenant_id = ${Number(locked.tenant_id)}`);
          creditReturned = true;
        }
      }
      await tx.execute(sql`UPDATE wallet_activations SET state = ${state}, error_code = ${code}, refund_billing_event_id = COALESCE(${refundId}::bigint, refund_billing_event_id), updated_at = ${iso(now)}::timestamptz WHERE id = ${Number(row.id)}`);
      for (const action of actions) {
        if (action === "activation_refunded" && refundId === null && !locked.refund_billing_event_id && !creditReturned) continue; // nothing was charged, nothing to refund
        await auditInTx(tx, action, row.user_id, { activationId: Number(row.id), chain: "stellar", address: row.address, code, ...(action === "activation_refunded" ? { refundBillingEventId: refundId, ...(creditReturned ? { creditReturned: row.credit_plan } : {}) } : { txHash: row.tx_hash }) });
      }
    });
  }
}

/** Runs the worker on an interval without overlapping ticks. Returns a stop function. */
export function startActivationWorker(worker: ActivationWorker, everyMs = 15_000): () => void {
  const timer = setInterval(() => { worker.tick().catch((e) => appLog().error({ code: codeOf(e) }, "activation_tick_failed")); }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
