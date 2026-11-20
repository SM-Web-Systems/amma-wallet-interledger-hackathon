/**
 * Business balance floor and controls (BUSINESS_CONTROLS=on, testnet only; owner decisions of 16 Nov 2026, stage 5).
 *
 * Floor: the management pot must never dip below 2 months of wallet fees, with growth (managementFloor in credit-plans.ts).
 * A regular check compares the two. Below the floor, the business and the owner are warned; after 7 days still below, new
 * activations stop. Learners keep their wallets: only new activations stop. Back above the floor, activations resume at once
 * (the intake compares the live pot with the stored floor) and the next check clears the hold and says so.
 *
 * Controls: a business can pause and resume its own activations and change its daily cap. In-flight activations finish.
 *
 * Alerts (business_alerts): each warning, hold, clearance, low balance, pause, resume and cap change, with who it went to.
 * Floor alerts are state-driven: a warning or hold that hasn't been delivered for the current episode is sent again on the
 * next check, so a mail outage never loses one.
 */
import { sql } from "drizzle-orm";
import { appLog } from "../lib/app-log";
import type { AuditAction } from "../lib/audit";
import { iso, rowsOf, type ActivationDb } from "../modules/activation/errors";
import { fromStroops, managementFloor, monthStart, toStroops, type ManagedWallet, type Plan } from "./credit-plans";
import type { Mailer } from "./business-deposits";

type Db = Pick<ActivationDb, "execute" | "transaction">;
type Exec = Pick<ActivationDb, "execute">;

export const GRACE_DAYS = 7;
const DAY_MS = 86_400_000;
/** A low-balance alert goes out at most once a week. */
const LOW_BALANCE_EVERY_MS = 7 * DAY_MS;
/** Fewer unused credits than this is a low balance. */
export const LOW_CREDITS = 10;
/** A pot within 25 % above its floor is a low balance (a warning before the floor warning). */
const NEAR_FLOOR_PERCENT = 125n;
export const DAILY_CAP_MAX = 1000;

export type AlertKind = "floor_warning" | "floor_hold" | "floor_cleared" | "low_balance" | "paused" | "resumed" | "daily_cap_changed";

const auditInTx = async (tx: Exec, action: AuditAction, detail: Record<string, unknown>) =>
  tx.execute(sql`INSERT INTO audit_logs (user_id, action, detail) VALUES (${null}, ${action}, ${JSON.stringify(detail)}::jsonb)`);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Reading the controls ──────────────────────────────────────────────────────────────────────────────────────────

export interface Controls { pausedAt: string | null; pausedBy: string | null; floor: string | null; management: string | null; checkedAt: string | null; belowSince: string | null; holdSince: string | null }

/** True once business-controls-v1 is applied. Checked on every call while false, so applying it takes effect without a restart. */
let present = false;
export async function controlsPresent(db: Exec): Promise<boolean> {
  if (present) return true;
  present = Boolean(rowsOf<{ present: boolean }>(await db.execute(sql`SELECT to_regclass('public.business_activation_controls') IS NOT NULL AS present`))[0]?.present);
  return present;
}
/** For tests that drop and recreate databases. */
export const forgetControlsPresent = () => { present = false; };

export async function readControls(db: Exec, tenantId: number): Promise<Controls | null> {
  if (!(await controlsPresent(db))) return null;
  const r = rowsOf<{ paused_at: string | null; paused_by: string | null; floor: string | null; management: string | null; floor_checked_at: string | null; below_floor_since: string | null; floor_hold_since: string | null }>(await db.execute(sql`
    SELECT paused_at, paused_by, floor_xlm::text AS floor, management_xlm::text AS management, floor_checked_at, below_floor_since, floor_hold_since
    FROM business_activation_controls WHERE tenant_id = ${tenantId}`))[0];
  if (!r) return null;
  return { pausedAt: r.paused_at, pausedBy: r.paused_by, floor: r.floor, management: r.management, checkedAt: r.floor_checked_at, belowSince: r.below_floor_since, holdSince: r.floor_hold_since };
}

/**
 * Whether new credit-paid activations are stopped by the floor right now. A hold ends as soon as the live pot is back at or
 * above the floor last worked out, so a business that tops up can activate again without waiting for the next check.
 */
export function floorHoldActive(controls: Controls | null, livePot: string | null): boolean {
  if (!controls?.holdSince) return false;
  if (controls.floor !== null && livePot !== null && toStroops(livePot) >= toStroops(controls.floor)) return false;
  return true;
}

// ── Alerts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AlertDeps { mail: Mailer; ownerEmail: string; now: Date }

async function recipients(db: Exec, tenantId: number, ownerEmail: string): Promise<{ label: string; to: string }[]> {
  const t = rowsOf<{ contact_email: string | null }>(await db.execute(sql`SELECT contact_email FROM tenants WHERE id = ${tenantId}`))[0];
  const out = [{ label: "owner", to: ownerEmail }];
  if (t?.contact_email && EMAIL.test(t.contact_email.trim())) out.unshift({ label: "business", to: t.contact_email.trim() });
  return out;
}

/** Emails the business (when it has a contact address) and the owner, and records the alert. Never throws for a mail failure. */
export async function sendAlert(db: Exec, deps: AlertDeps, tenantId: number, kind: AlertKind, message: { subject: string; html: string; detail: Record<string, unknown> }): Promise<boolean> {
  const to = await recipients(db, tenantId, deps.ownerEmail);
  let delivered = true;
  for (const r of to) {
    let ok = false;
    try { ok = await deps.mail(r.to, message.subject, message.html); } catch { ok = false; }
    if (!ok) delivered = false;
  }
  await db.execute(sql`INSERT INTO business_alerts (tenant_id, kind, detail, sent_to, delivered, created_at)
    VALUES (${tenantId}, ${kind}, ${JSON.stringify(message.detail)}::jsonb, ${`{${to.map((r) => r.label).join(",")}}`}::text[], ${delivered}, ${iso(deps.now)}::timestamptz)`);
  if (!delivered) appLog().error({ tenantId, kind }, "business_alert_not_delivered");
  return delivered;
}

async function deliveredSince(db: Exec, tenantId: number, kind: AlertKind, since: string | Date): Promise<boolean> {
  return rowsOf(await db.execute(sql`SELECT 1 FROM business_alerts WHERE tenant_id = ${tenantId} AND kind = ${kind} AND delivered = true
    AND created_at >= ${typeof since === "string" ? since : iso(since)}::timestamptz LIMIT 1`)).length > 0;
}

const nameOf = async (db: Exec, tenantId: number) =>
  rowsOf<{ name: string }>(await db.execute(sql`SELECT name FROM tenants WHERE id = ${tenantId}`))[0]?.name ?? `business ${tenantId}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

// ── The floor ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FloorReading { floor: string; management: string; creditsLeft: number; below: boolean; projectedWallets: number[] }

/** The business's floor and pot now. Activations per month are the last 3 finished months, oldest first. */
export async function readFloor(db: Exec, tenantId: number, now: Date): Promise<FloorReading | null> {
  const pots = rowsOf<{ management: string; annual: number; monthly: number }>(await db.execute(sql`
    SELECT management_xlm::text AS management, annual_credits AS annual, monthly_credits AS monthly FROM tenant_credit_balances WHERE tenant_id = ${tenantId}`))[0];
  if (!pots) return null;
  const rows = rowsOf<{ credit_plan: Plan; created_at: string; confirmed_at: string | null; management_paid_until: string | null; deleted_at: string | null }>(await db.execute(sql`
    SELECT credit_plan, created_at, confirmed_at, management_paid_until, deleted_at FROM wallet_activations
    WHERE tenant_id = ${tenantId} AND state = 'confirmed' AND credit_plan IS NOT NULL`));
  const wallets = rows.map((w): ManagedWallet => ({
    plan: w.credit_plan, activatedAt: new Date(w.confirmed_at ?? w.created_at),
    paidUntil: w.management_paid_until ? new Date(w.management_paid_until) : null, deletedAt: w.deleted_at ? new Date(w.deleted_at) : null,
  }));
  const activationsPerMonth = [-3, -2, -1].map((m) => {
    const from = monthStart(now, m), to = monthStart(now, m + 1);
    return wallets.filter((w) => w.activatedAt >= from && w.activatedAt < to).length;
  });
  const unusedCredits = { annual: Number(pots.annual), monthly: Number(pots.monthly) };
  const { floor, projectedWallets } = managementFloor({ wallets, activationsPerMonth, unusedCredits, now });
  return { floor, management: pots.management, creditsLeft: unusedCredits.annual + unusedCredits.monthly, below: toStroops(pots.management) < toStroops(floor), projectedWallets };
}

export interface FloorCheckResult { tenants: number; warned: number; held: number; cleared: number; lowBalance: number }

/** One pass over every active business with a credit account (or one business). Safe to run as often as you like. */
export async function checkFloors(db: Db, deps: AlertDeps & { tenantId?: number }): Promise<FloorCheckResult> {
  const result: FloorCheckResult = { tenants: 0, warned: 0, held: 0, cleared: 0, lowBalance: 0 };
  const tenants = rowsOf<{ id: string }>(await db.execute(deps.tenantId
    ? sql`SELECT t.id FROM tenants t JOIN tenant_credit_balances b ON b.tenant_id = t.id WHERE t.id = ${deps.tenantId}`
    : sql`SELECT t.id FROM tenants t JOIN tenant_credit_balances b ON b.tenant_id = t.id WHERE t.is_active = true ORDER BY t.id`));
  for (const t of tenants) {
    try { await checkOne(db, deps, Number(t.id), result); result.tenants++; }
    catch { appLog().error({ tenantId: Number(t.id) }, "business_floor_check_failed"); }
  }
  return result;
}

async function checkOne(db: Db, deps: AlertDeps, tenantId: number, result: FloorCheckResult) {
  const { now } = deps;
  const reading = await readFloor(db, tenantId, now);
  if (!reading) return;
  const change = await db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO business_activation_controls (tenant_id) VALUES (${tenantId}) ON CONFLICT (tenant_id) DO NOTHING`);
    const before = rowsOf<{ below_floor_since: string | null; floor_hold_since: string | null }>(await tx.execute(sql`
      SELECT below_floor_since, floor_hold_since FROM business_activation_controls WHERE tenant_id = ${tenantId} FOR UPDATE`))[0];
    let belowSince = before.below_floor_since ? new Date(before.below_floor_since) : null;
    let holdSince = before.floor_hold_since ? new Date(before.floor_hold_since) : null;
    let event: "held" | "cleared" | null = null;
    if (reading.below) {
      if (!belowSince) belowSince = now;
      if (!holdSince && now.getTime() - belowSince.getTime() >= GRACE_DAYS * DAY_MS) { holdSince = now; event = "held"; }
    } else if (belowSince) {
      event = "cleared"; belowSince = null; holdSince = null;
    }
    await tx.execute(sql`UPDATE business_activation_controls SET floor_xlm = ${reading.floor}::numeric, management_xlm = ${reading.management}::numeric,
      floor_checked_at = ${iso(now)}::timestamptz, below_floor_since = ${belowSince ? iso(belowSince) : null}::timestamptz,
      floor_hold_since = ${holdSince ? iso(holdSince) : null}::timestamptz, updated_at = ${iso(now)}::timestamptz WHERE tenant_id = ${tenantId}`);
    if (event === "held") await auditInTx(tx, "business_floor_hold", { tenantId, floor: reading.floor, management: reading.management, belowSince: iso(belowSince!) });
    if (event === "cleared") await auditInTx(tx, "business_floor_cleared", { tenantId, floor: reading.floor, management: reading.management, wasHeld: Boolean(before.floor_hold_since) });
    return { belowSince, holdSince, event };
  });

  // Alerts after the commit. Warnings and holds are re-sent until one is delivered for this episode.
  const name = await nameOf(db, tenantId);
  const shortfall = fromStroops(toStroops(reading.floor) - toStroops(reading.management));
  const facts = `<ul><li>Management balance: ${escapeHtml(reading.management)} XLM</li><li>Floor (2 months of wallet fees): ${escapeHtml(reading.floor)} XLM</li></ul>`;
  if (change.belowSince && !change.holdSince && !(await deliveredSince(db, tenantId, "floor_warning", change.belowSince))) {
    const stopOn = day(new Date(change.belowSince.getTime() + GRACE_DAYS * DAY_MS));
    await sendAlert(db, deps, tenantId, "floor_warning", {
      subject: `Amma Wallet: ${name} is below its balance floor`,
      html: `<p>${escapeHtml(name)}'s wallet management balance is below its floor by ${escapeHtml(shortfall)} XLM.</p>${facts}
        <p>Please top up with a bundle before <b>${stopOn}</b>. If the balance is still below the floor then, new learner activations stop. Learners who already have wallets keep them.</p>`,
      detail: { floor: reading.floor, management: reading.management, shortfall, stopOn },
    });
    result.warned++;
  }
  if (change.holdSince && !(await deliveredSince(db, tenantId, "floor_hold", change.holdSince))) {
    await sendAlert(db, deps, tenantId, "floor_hold", {
      subject: `Amma Wallet: new activations stopped for ${name}`,
      html: `<p>${escapeHtml(name)}'s management balance has been below its floor for ${GRACE_DAYS} days, so new learner activations have stopped. Learners who already have wallets keep them.</p>${facts}
        <p>Top up with a bundle and activations resume straight away.</p>`,
      detail: { floor: reading.floor, management: reading.management, shortfall },
    });
    result.held++;
  }
  if (change.event === "cleared") {
    await sendAlert(db, deps, tenantId, "floor_cleared", {
      subject: `Amma Wallet: ${name} is back above its balance floor`,
      html: `<p>${escapeHtml(name)}'s management balance is back above its floor. New activations continue as normal.</p>${facts}`,
      detail: { floor: reading.floor, management: reading.management },
    });
    result.cleared++;
  }

  // Low balance: few credits left, or the pot close to its floor. Only for a business that has bought a bundle; at most weekly.
  const nearFloor = !reading.below && toStroops(reading.floor) > 0n && toStroops(reading.management) * 100n < toStroops(reading.floor) * NEAR_FLOOR_PERCENT;
  const fewCredits = reading.creditsLeft < LOW_CREDITS;
  if ((nearFloor || fewCredits) && !change.belowSince) {
    const bought = rowsOf(await db.execute(sql`SELECT 1 FROM credit_ledger WHERE tenant_id = ${tenantId} AND event = 'bundle_credit' LIMIT 1`)).length > 0;
    if (bought && !(await deliveredSince(db, tenantId, "low_balance", new Date(now.getTime() - LOW_BALANCE_EVERY_MS)))) {
      const reasons = [fewCredits ? `${reading.creditsLeft} activation credits left` : null, nearFloor ? "the management balance is close to its floor" : null].filter(Boolean) as string[];
      await sendAlert(db, deps, tenantId, "low_balance", {
        subject: `Amma Wallet: ${name} is running low`,
        html: `<p>${escapeHtml(name)} is running low: ${escapeHtml(reasons.join(", and "))}.</p>${facts}<p>A new bundle keeps activations going without a break.</p>`,
        detail: { creditsLeft: reading.creditsLeft, floor: reading.floor, management: reading.management, reasons },
      });
      result.lowBalance++;
    }
  }
}

// ── Controls a business (or staff) can change ─────────────────────────────────────────────────────────────────────

async function ensureRow(tx: Exec, tenantId: number) {
  await tx.execute(sql`INSERT INTO business_activation_controls (tenant_id) VALUES (${tenantId}) ON CONFLICT (tenant_id) DO NOTHING`);
}

/** Pauses new activations for a business. Returns false when it was already paused. */
export async function pauseActivations(db: Db, deps: AlertDeps, input: { tenantId: number; by: string }): Promise<{ changed: boolean }> {
  const by = input.by.slice(0, 80);
  const changed = await db.transaction(async (tx) => {
    await ensureRow(tx, input.tenantId);
    const moved = rowsOf(await tx.execute(sql`UPDATE business_activation_controls SET paused_at = ${iso(deps.now)}::timestamptz, paused_by = ${by}, updated_at = ${iso(deps.now)}::timestamptz
      WHERE tenant_id = ${input.tenantId} AND paused_at IS NULL RETURNING tenant_id`)).length > 0;
    if (moved) await auditInTx(tx, "business_activations_paused", { tenantId: input.tenantId, by });
    return moved;
  });
  if (changed) {
    const name = await nameOf(db, input.tenantId);
    await sendAlert(db, deps, input.tenantId, "paused", {
      subject: `Amma Wallet: activations paused for ${name}`,
      html: `<p>New learner activations for ${escapeHtml(name)} were paused (by ${escapeHtml(by)}). Activations already under way finish; learners keep their wallets. Resume at any time.</p>`,
      detail: { by },
    });
  }
  return { changed };
}

export async function resumeActivations(db: Db, deps: AlertDeps, input: { tenantId: number; by: string }): Promise<{ changed: boolean }> {
  const by = input.by.slice(0, 80);
  const changed = await db.transaction(async (tx) => {
    await ensureRow(tx, input.tenantId);
    const moved = rowsOf(await tx.execute(sql`UPDATE business_activation_controls SET paused_at = NULL, paused_by = NULL, updated_at = ${iso(deps.now)}::timestamptz
      WHERE tenant_id = ${input.tenantId} AND paused_at IS NOT NULL RETURNING tenant_id`)).length > 0;
    if (moved) await auditInTx(tx, "business_activations_resumed", { tenantId: input.tenantId, by });
    return moved;
  });
  if (changed) {
    const name = await nameOf(db, input.tenantId);
    await sendAlert(db, deps, input.tenantId, "resumed", {
      subject: `Amma Wallet: activations resumed for ${name}`,
      html: `<p>New learner activations for ${escapeHtml(name)} were resumed (by ${escapeHtml(by)}).</p>`,
      detail: { by },
    });
  }
  return { changed };
}

/** Changes the business's own daily activation cap (0 to 1000). Recorded as an alert, not emailed. */
export async function setDailyCap(db: Db, deps: Pick<AlertDeps, "now">, input: { tenantId: number; dailyCap: number; by: string }): Promise<{ before: number; after: number }> {
  if (!Number.isInteger(input.dailyCap) || input.dailyCap < 0 || input.dailyCap > DAILY_CAP_MAX) throw new RangeError(`The daily cap must be a whole number from 0 to ${DAILY_CAP_MAX}`);
  const by = input.by.slice(0, 80);
  return db.transaction(async (tx) => {
    const row = rowsOf<{ daily_cap: number }>(await tx.execute(sql`SELECT daily_cap FROM partner_activation_settings WHERE tenant_id = ${input.tenantId} FOR UPDATE`))[0];
    if (!row) throw new RangeError("This business isn't set up for activations yet");
    const before = Number(row.daily_cap);
    if (before !== input.dailyCap) {
      await tx.execute(sql`UPDATE partner_activation_settings SET daily_cap = ${input.dailyCap}, updated_at = ${iso(deps.now)}::timestamptz, updated_by = ${by} WHERE tenant_id = ${input.tenantId}`);
      await auditInTx(tx, "business_daily_cap_changed", { tenantId: input.tenantId, before, after: input.dailyCap, by });
      await tx.execute(sql`INSERT INTO business_alerts (tenant_id, kind, detail, delivered, created_at)
        VALUES (${input.tenantId}, 'daily_cap_changed', ${JSON.stringify({ before, after: input.dailyCap, by })}::jsonb, true, ${iso(deps.now)}::timestamptz)`);
    }
    return { before, after: input.dailyCap };
  });
}

/** What the business sees: pause state, daily cap, floor, and its latest alerts. */
export async function controlsView(db: Exec, tenantId: number) {
  const controls = await readControls(db, tenantId);
  const cap = rowsOf<{ daily_cap: number }>(await db.execute(sql`SELECT daily_cap FROM partner_activation_settings WHERE tenant_id = ${tenantId}`))[0];
  const pot = rowsOf<{ management: string }>(await db.execute(sql`SELECT management_xlm::text AS management FROM tenant_credit_balances WHERE tenant_id = ${tenantId}`))[0];
  const alerts = (await controlsPresent(db)) ? rowsOf<{ kind: string; detail: unknown; created_at: string }>(await db.execute(sql`
    SELECT kind, detail, created_at FROM business_alerts WHERE tenant_id = ${tenantId} ORDER BY id DESC LIMIT 10`)) : [];
  const stopsOn = controls?.belowSince && !controls.holdSince ? day(new Date(new Date(controls.belowSince).getTime() + GRACE_DAYS * DAY_MS)) : null;
  return {
    paused: Boolean(controls?.pausedAt), pausedAt: controls?.pausedAt ?? null,
    dailyCap: cap ? Number(cap.daily_cap) : null,
    floor: { floor: controls?.floor ?? null, management: pot?.management ?? null, checkedAt: controls?.checkedAt ?? null, belowSince: controls?.belowSince ?? null, activationsStopOn: stopsOn,
      activationsStopped: floorHoldActive(controls, pot?.management ?? null) },
    alerts: alerts.map((a) => ({ kind: a.kind, detail: a.detail, at: a.created_at })),
  };
}

/** Runs the floor check on an interval under a single-runner lock. Returns a stop function. */
export function startFloorCheck(run: () => Promise<unknown>, lock: () => Promise<null | (() => Promise<void>)>, everyMs = 60 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    let release: null | (() => Promise<void>) = null;
    try { release = await lock(); if (release) await run(); }
    catch { appLog().error({}, "business_floor_tick_failed"); }
    finally { running = false; if (release) await release().catch(() => undefined); }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
