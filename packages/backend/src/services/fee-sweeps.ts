/**
 * Fee sweeps (BUSINESS_FEE_SWEEPS=on; owner decisions of 16 Nov 2026).
 *
 * What a business has paid in fees is moved from its Amma-held wallet to its own hardware fee address:
 *   - for each credited deposit, its fee_due_xlm (2 XLM per user, yearly management, and the registration fee when charged);
 *   - for each monthly management charge, the amount charged.
 * The hardware wallet only receives; the server never holds its key.
 *
 * Each source is swept at most once (fee_sweeps is unique per network and source). A sweep leaves the wallet enough for the
 * funding and management pots, activations not yet sent, other sweeps in flight, deposits held for the owner (not the
 * business's money to spend until resolved), the account reserve and a 0.01 XLM network-fee float; otherwise it waits.
 * An exact deposit leaves no room for the float, so up to 0.01 XLM of the fee is withheld and stays in the wallet to pay
 * network fees; the sweep row then records what was sent, and the audit and ledger say what was booked and withheld.
 * Same order of events as activation: claim, build, store the hash (write-ahead), submit, confirm. Every hash ever built is
 * looked up before a sweep is tried again, so a transaction that landed late is confirmed, never paid twice.
 */
import { sql } from "drizzle-orm";
import { appLog } from "../lib/app-log";
import type { AuditAction } from "../lib/audit";
import { iso, rowsOf, type ActivationDb } from "../modules/activation/errors";
import type { StellarRail } from "../modules/activation/stellar-rail";
import { fromStroops, toStroops } from "./credit-plans";
import { assignFeeAddress, type StellarNetwork } from "./business-wallets";

export const MAX_SWEEP_ATTEMPTS = 5;
const RESERVE_STROOPS = 10_000_000n; // 1 XLM base reserve the business wallet keeps
/** 0.01 XLM the wallet keeps for network fees (sweeps and activations), so they never eat into the reserve. */
export const FEE_FLOAT_STROOPS = 100_000n;
const RETRY_AFTER_SECONDS = 120;
const DEAD_GRACE_SECONDS = 30;
const STALE_SUBMITTING_MS = 2 * 60_000;

type Sweep = { id: string; tenant_id: string; source_ref: string; amount: string; to_address: string | null; from_address: string | null; attempts: number; tx_hash: string | null; tx_hashes: string[] | null; deadline: string | null; state: string };
// Same short codes as the activation worker; never an error message, which can carry URLs or bodies.
function codeOf(e: unknown): string {
  const status = (e as any)?.response?.status ?? (e as any)?.status;
  if ((e as any)?.name === "TimeoutError" || (e as any)?.name === "AbortError" || status === 504) return "timeout";
  return typeof status === "number" ? `horizon-${status}` : "horizon-unavailable";
}
const COLUMNS = sql.raw("id, tenant_id, source_ref, amount_xlm::text AS amount, to_address, from_address, attempts, tx_hash, tx_hashes, deadline, state");

const auditInTx = async (tx: Pick<ActivationDb, "execute">, action: AuditAction, detail: Record<string, unknown>) =>
  tx.execute(sql`INSERT INTO audit_logs (user_id, action, detail) VALUES (${null}, ${action}, ${JSON.stringify(detail)}::jsonb)`);

/**
 * How much of a booked fee to send, given what the wallet can spare after everything it must keep (float included).
 * The whole fee when there's room; up to the float less when there isn't (the float then comes out of the fee); otherwise null.
 */
export function sweepable(booked: bigint, spare: bigint): bigint | null {
  if (spare >= booked) return booked;
  if (spare <= 0n || booked - spare > FEE_FLOAT_STROOPS) return null;
  return spare;
}

/** What the source booked as fee (the row's amount may be up to the float less, once sent). */
async function bookedFee(db: Pick<ActivationDb, "execute">, row: Pick<Sweep, "source_ref" | "amount">): Promise<bigint> {
  const [kind, ref] = row.source_ref.split(":");
  const source = rowsOf<{ booked: string | null }>(await db.execute(kind === "deposit"
    ? sql`SELECT fee_due_xlm::text AS booked FROM business_deposits WHERE id = ${Number(ref)}`
    : sql`SELECT fee_xlm::text AS booked FROM credit_ledger WHERE id = ${Number(ref)}`))[0];
  return source?.booked ? toStroops(source.booked) : toStroops(row.amount);
}

/** Adds a sweep for every credited deposit and management charge that has none yet. Returns how many were added. */
export async function enqueueFeeSweeps(db: Pick<ActivationDb, "execute">, network: StellarNetwork): Promise<number> {
  const deposits = rowsOf(await db.execute(sql`
    INSERT INTO fee_sweeps (tenant_id, network, source_ref, amount_xlm)
    SELECT d.tenant_id, d.network, 'deposit:' || d.id, d.fee_due_xlm FROM business_deposits d
    WHERE d.network = ${network} AND d.state = 'credited' AND d.fee_due_xlm > 0
    ON CONFLICT (network, source_ref) DO NOTHING RETURNING id`));
  // Only charges made while the business had a wallet on this network: those were paid into it.
  const charges = rowsOf(await db.execute(sql`
    INSERT INTO fee_sweeps (tenant_id, network, source_ref, amount_xlm)
    SELECT l.tenant_id, ${network}, 'management:' || l.id, l.fee_xlm FROM credit_ledger l
    WHERE l.event = 'management_charge' AND l.fee_xlm > 0
      AND EXISTS (SELECT 1 FROM business_wallets w WHERE w.tenant_id = l.tenant_id AND w.network = ${network} AND w.retired_at IS NULL AND w.created_at <= l.created_at)
    ON CONFLICT (network, source_ref) DO NOTHING RETURNING id`));
  return deposits.length + charges.length;
}

export interface SweepOptions {
  db: ActivationDb;
  network: StellarNetwork;
  /** The rail that pays from the business's own wallet (see businessRailSource). */
  railFor: (tenantId: number) => Promise<StellarRail | null>;
  /** Any rail on this network, for lookups and ledger times. */
  lookup: Pick<StellarRail, "lookup" | "ledgerClosedAt">;
  now?: () => Date;
  batch?: number;
}
export interface SweepResult { queued: number; confirmed: number; failed: number; waiting: number }

export class FeeSweeper {
  private readonly now: () => Date;
  constructor(private readonly o: SweepOptions) { this.now = o.now ?? (() => new Date()); }

  async tick(): Promise<SweepResult> {
    const result: SweepResult = { queued: await enqueueFeeSweeps(this.o.db, this.o.network), confirmed: 0, failed: 0, waiting: 0 };
    await this.recover(result);
    await this.send(result);
    return result;
  }

  // ── sweeps whose outcome is not known yet ────────────────────────────────────────────────
  private async recover(result: SweepResult) {
    const { db, network } = this.o;
    const now = this.now();
    const rows = rowsOf<Sweep>(await db.execute(sql`SELECT ${COLUMNS} FROM fee_sweeps WHERE network = ${network} AND state IN ('submitting','submitted') ORDER BY id LIMIT 20`));
    let ledgerClosed: number | null | undefined;
    for (const row of rows) {
      if (!row.deadline) {
        // Claimed but nothing built, so nothing was sent: hand it back once it is clearly abandoned.
        await db.execute(sql`UPDATE fee_sweeps SET state = 'pending', attempts = GREATEST(attempts - 1, 0), updated_at = ${iso(now)}::timestamptz
          WHERE id = ${Number(row.id)} AND state = 'submitting' AND deadline IS NULL AND updated_at < ${iso(new Date(now.getTime() - STALE_SUBMITTING_MS))}::timestamptz`);
        continue;
      }
      const landed = await this.landed(row);
      if (landed === "unknown") continue;
      if (landed) { await this.confirm(row, landed, result); continue; }
      if (Math.floor(now.getTime() / 1000) <= Number(row.deadline) + DEAD_GRACE_SECONDS) continue;
      // Dead only when Horizon itself has ingested past the time bounds, not by the wall clock alone.
      if (ledgerClosed === undefined) { try { ledgerClosed = await this.o.lookup.ledgerClosedAt(); } catch { ledgerClosed = null; } }
      if (ledgerClosed !== null && ledgerClosed > Number(row.deadline) + DEAD_GRACE_SECONDS) await this.retryOrFail(row, "expired", result);
    }
  }

  /** A hash that landed, "unknown" when Horizon couldn't answer for one of them, or null when none did. */
  private async landed(row: Sweep): Promise<string | "unknown" | null> {
    const fresh = rowsOf<{ tx_hashes: string[] }>(await this.o.db.execute(sql`SELECT tx_hashes FROM fee_sweeps WHERE id = ${Number(row.id)}`))[0];
    const hashes = [...new Set([...(fresh?.tx_hashes ?? []), ...(row.tx_hashes ?? []), ...(row.tx_hash ? [row.tx_hash] : [])])];
    let unknown = false;
    for (const hash of hashes) {
      try { if ((await this.o.lookup.lookup(hash)) === "success") return hash; } catch { unknown = true; }
    }
    return unknown ? "unknown" : null;
  }

  // ── new work ────────────────────────────────────────────────────────────────────────────
  private async send(result: SweepResult) {
    const { db, network } = this.o;
    const now = this.now();
    const due = rowsOf<Sweep>(await db.execute(sql`SELECT ${COLUMNS} FROM fee_sweeps WHERE network = ${network} AND state = 'pending' AND attempts < ${MAX_SWEEP_ATTEMPTS}
      AND (attempts = 0 OR updated_at <= ${iso(now)}::timestamptz - interval '${sql.raw(String(RETRY_AFTER_SECONDS))} seconds') ORDER BY id LIMIT ${this.o.batch ?? 10}`));
    const blocked = new Set<number>(); // a business that can't pay right now is skipped for the rest of this pass
    for (const row of due) {
      const tenantId = Number(row.tenant_id);
      if (blocked.has(tenantId)) { result.waiting++; continue; }
      const outcome = await this.attempt(row, result);
      if (outcome === "wait") { blocked.add(tenantId); result.waiting++; }
      if (outcome === "stop") return;
    }
  }

  private async attempt(row: Sweep, result: SweepResult): Promise<"wait" | "stop" | void> {
    const { db, network } = this.o;
    const tenantId = Number(row.tenant_id);
    const id = Number(row.id);
    const booked = await bookedFee(db, row);
    const to = await this.feeAddress(tenantId);
    if (!to) { appLog().warn({ tenantId }, "fee_sweep_no_fee_address"); return "wait"; }
    let rail: StellarRail | null = null;
    try { rail = await this.o.railFor(tenantId); } catch { rail = null; }
    if (!rail?.buildPayment) { appLog().error({ tenantId }, "fee_sweep_wallet_unavailable"); return "wait"; }
    if (rail.treasuryAddress === to) { appLog().error({ tenantId }, "fee_sweep_refused_same_address"); return "wait"; }

    // What the wallet must keep: both pots, activations not yet sent, other sweeps in flight, held deposits, the reserve and the fee float.
    let balance: bigint;
    try { balance = await rail.treasuryStroops(); } catch (e) { appLog().warn({ tenantId, code: codeOf(e) }, "fee_sweep_balance_unreadable"); return "stop"; }
    const keep = rowsOf<{ pots: string; activations: string; inflight: string; held: string }>(await db.execute(sql`
      SELECT (SELECT COALESCE(funding_xlm + GREATEST(management_xlm, 0), 0) FROM tenant_credit_balances WHERE tenant_id = ${tenantId})::text AS pots,
        (SELECT COALESCE(sum(grant_base_units), 0) FROM wallet_activations WHERE tenant_id = ${tenantId} AND network = ${network} AND credit_plan IS NOT NULL
          AND state IN ('reserved','submitting','submitted','failed'))::text AS activations,
        (SELECT COALESCE(sum(amount_xlm), 0) FROM fee_sweeps WHERE tenant_id = ${tenantId} AND network = ${network} AND state IN ('submitting','submitted') AND id <> ${id})::text AS inflight,
        (SELECT COALESCE(sum(amount_xlm), 0) FROM business_deposits WHERE tenant_id = ${tenantId} AND network = ${network} AND state = 'held')::text AS held`))[0];
    const kept = toStroops(keep?.pots ?? "0") + BigInt(keep?.activations ?? "0") + toStroops(keep?.inflight ?? "0") + toStroops(keep?.held ?? "0") + RESERVE_STROOPS + FEE_FLOAT_STROOPS;
    // Send the whole fee when there's room; withhold at most the float (an exact deposit), never more.
    const amount = sweepable(booked, balance - kept);
    if (amount === null) { appLog().warn({ tenantId, sweepId: id }, "fee_sweep_short"); return "wait"; }

    const now = this.now();
    const claimed = rowsOf<Sweep>(await db.execute(sql`UPDATE fee_sweeps SET state = 'submitting', attempts = attempts + 1, error_code = NULL, deadline = NULL,
      from_address = ${rail.treasuryAddress}, to_address = ${to}, updated_at = ${iso(now)}::timestamptz
      WHERE id = ${id} AND state = 'pending' RETURNING ${COLUMNS}`))[0];
    if (!claimed) return;
    const release = async (code: string): Promise<"stop"> => {
      appLog().warn({ sweepId: id, code }, "fee_sweep_not_sent");
      await db.execute(sql`UPDATE fee_sweeps SET state = 'pending', attempts = GREATEST(attempts - 1, 0), updated_at = ${iso(this.now())}::timestamptz WHERE id = ${id} AND state = 'submitting' AND deadline IS NULL`);
      return "stop";
    };
    // A sweep tried before may have landed late: look before building another.
    if ((claimed.tx_hashes ?? []).length) {
      const prior = await this.landed(claimed);
      if (prior === "unknown") return release("lookup-unknown");
      if (prior) return this.confirm(claimed, prior, result);
    }
    let exists: boolean;
    try { exists = (await rail.account(to)).exists; } catch (e) { return release(codeOf(e)); }
    // The first payment to a new hardware address creates it, which needs at least the 1 XLM reserve.
    if (!exists && amount < RESERVE_STROOPS) { await release("fee-address-unfunded"); return "wait"; }
    let built;
    try { built = await rail.buildPayment(to, amount, Math.floor(this.now().getTime() / 1000), !exists); } catch (e) { return release(codeOf(e)); }
    // The amount is stored with its hash, so the row always says what the newest (the only live) transaction pays.
    const stored = rowsOf(await db.execute(sql`UPDATE fee_sweeps SET amount_xlm = ${fromStroops(amount)}::numeric, tx_hash = ${built.hash}, tx_hashes = array_append(tx_hashes, ${built.hash}), deadline = ${built.maxTime}, updated_at = ${iso(this.now())}::timestamptz
      WHERE id = ${id} AND state = 'submitting' AND deadline IS NULL RETURNING id`));
    if (!stored.length) return;
    const stamped = { ...claimed, tx_hash: built.hash, tx_hashes: [...(claimed.tx_hashes ?? []), built.hash], deadline: String(built.maxTime), to_address: to };
    let outcome;
    try { outcome = await rail.submit(built.envelope); }
    catch (e) {
      appLog().warn({ sweepId: id, code: codeOf(e) }, "fee_sweep_submit_unknown");
      await db.execute(sql`UPDATE fee_sweeps SET state = 'submitted', updated_at = ${iso(this.now())}::timestamptz WHERE id = ${id} AND state = 'submitting'`);
      return;
    }
    if (!outcome.accepted) return this.retryOrFail(stamped, outcome.code, result);
    await db.execute(sql`UPDATE fee_sweeps SET state = 'submitted', updated_at = ${iso(this.now())}::timestamptz WHERE id = ${id} AND state = 'submitting'`);
    try { if ((await this.o.lookup.lookup(built.hash)) === "success") await this.confirm(stamped, built.hash, result); } catch { /* confirmed on a later pass */ }
  }

  private async feeAddress(tenantId: number): Promise<string | null> {
    const current = rowsOf<{ address: string }>(await this.o.db.execute(sql`SELECT address FROM fee_address_pool WHERE tenant_id = ${tenantId} AND network = ${this.o.network}`))[0];
    if (current) return current.address;
    try { return (await assignFeeAddress(this.o.db, { tenantId, network: this.o.network, now: this.now(), by: "fee-sweeper" })).address; } catch { return null; }
  }

  private async retryOrFail(row: Sweep, code: string, result: SweepResult) {
    const prior = await this.landed(row);
    if (prior === "unknown") return;
    if (prior) return this.confirm(row, prior, result);
    const final = row.attempts >= MAX_SWEEP_ATTEMPTS;
    await this.o.db.transaction(async (tx) => {
      const moved = rowsOf(await tx.execute(sql`UPDATE fee_sweeps SET state = ${final ? "failed" : "pending"}, error_code = ${code.slice(0, 40)}, updated_at = ${iso(this.now())}::timestamptz
        WHERE id = ${Number(row.id)} AND state IN ('submitting','submitted') RETURNING id`));
      if (moved.length && final) await auditInTx(tx, "fee_sweep_failed", { sweepId: Number(row.id), tenantId: Number(row.tenant_id), source: row.source_ref, amount: row.amount, code });
    });
    if (final) { result.failed++; appLog().error({ sweepId: Number(row.id), code }, "fee_sweep_failed_final"); }
  }

  private async confirm(row: Sweep, hash: string, result: SweepResult) {
    const now = this.now();
    await this.o.db.transaction(async (tx) => {
      const moved = rowsOf<{ to_address: string; amount: string }>(await tx.execute(sql`UPDATE fee_sweeps SET state = 'confirmed', tx_hash = ${hash}, confirmed_at = ${iso(now)}::timestamptz, error_code = NULL, updated_at = ${iso(now)}::timestamptz
        WHERE id = ${Number(row.id)} AND state IN ('pending','submitting','submitted','failed') AND to_address IS NOT NULL RETURNING to_address, amount_xlm::text AS amount`))[0];
      if (!moved) return;
      // What was booked comes from the source; the row holds what was sent, which is up to the float less.
      const sent = toStroops(moved.amount);
      const booked = await bookedFee(tx, row);
      const withheld = booked > sent ? booked - sent : 0n;
      const note = withheld > 0n ? ` (booked ${fromStroops(booked)}, ${fromStroops(withheld)} kept as fee float)` : "";
      await tx.execute(sql`INSERT INTO credit_ledger (tenant_id, event, reference, idempotency_key, created_by)
        VALUES (${Number(row.tenant_id)}, 'fee_sweep', ${`${moved.amount} XLM to ${moved.to_address.slice(0, 6)}… tx ${hash}${note}`.slice(0, 200)}, ${`fee-sweep:${row.id}`}, 'fee-sweeper')
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`);
      await auditInTx(tx, "fee_sweep_confirmed", { sweepId: Number(row.id), tenantId: Number(row.tenant_id), source: row.source_ref, amount: moved.amount,
        booked: fromStroops(booked), withheld: fromStroops(withheld), to: moved.to_address, txHash: hash });
      result.confirmed++;
    });
  }
}

/** Runs the sweeper on an interval under a single-runner lock, without overlapping. Returns a stop function. */
export function startFeeSweeper(sweeper: FeeSweeper, lock: () => Promise<null | (() => Promise<void>)>, everyMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    let release: null | (() => Promise<void>) = null;
    try { release = await lock(); if (release) await sweeper.tick(); }
    catch { appLog().error({}, "fee_sweep_tick_failed"); }
    finally { running = false; if (release) await release().catch(() => undefined); }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
