import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ActivationFlags } from "../../lib/activation-flags";
import type { AuditAction } from "../../lib/audit";
import { addDecimalStrings, compareDecimalStrings, negateDecimalString, maybeNotifyDeficit, writeBillingDebit } from "../../services/billing.service";
import { ActivationError, iso, rowsOf, stroopsToXlm, type ActivationDb } from "./errors";
export { stroopsToXlm };
import type { PartnerContext } from "./partner-auth";
import { annualPaidUntil, nextCredit, type Plan as CreditPlan } from "../../services/credit-plans";
import { preCheckRequirement, REQUIREMENT_COLUMNS, requirementOf, type NftHolding } from "./requirement";
import { floorHoldActive, readControls } from "../../services/business-controls";

export interface IntakeDeps {
  db: ActivationDb;
  flags: ActivationFlags;
  now: () => Date;
  paused: () => boolean;
  /** custodyAllowedForUser bound to the custody flags: on mainnet only allow-listed users. */
  custodyAllowed: (userId: number) => boolean;
  /** recoveryFreezeActive. */
  frozen: (userId: number) => Promise<boolean>;
  /** Reads whether an address holds a token of a SEP-50 contract, for tasks with an NFT requirement (see requirement.ts). */
  nftHolding?: NftHolding;
}
export interface ActivationView {
  activationId: string;
  completionId: string;
  taskKey: string;
  status: "pending" | "confirmed" | "failed" | "skipped";
  chains: { chain: string; network?: string; address?: string; state: string; txHash?: string }[];
}
export interface IntakeResult { status: 200 | 202; body: ActivationView }

const DAY = 86_400_000;

// What counts against a cap: everything that cost, or is costing, a grant.
const COUNTED = "state NOT IN ('skipped_already_active','skipped_chain_unavailable','refunded','failed_final','expired')";
export const INTAKE_LOCK = sql`SELECT pg_advisory_xact_lock(731241, 12)`;


/** Eligibility step 1: the switch and the pause file. Called before anything else, including authentication. */
export function assertAvailable(deps: Pick<IntakeDeps, "flags" | "paused">): void {
  if (!deps.flags.enabled) throw new ActivationError("ACTIVATION_OFF", 503);
  if (deps.paused()) throw new ActivationError("ACTIVATION_PAUSED", 503, true);
}

// ── Step 3: strict body ─────────────────────────────────────────────────────────────────────────────────────
export interface ActivationRequest { ammaUserId: number; taskKey: string; completionId: string; idempotencyKey: string; completedAt: string }
const FIELDS = ["ammaUserId", "taskKey", "completionId", "idempotencyKey", "completedAt"] as const;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const bad = () => new ActivationError("INVALID_REQUEST", 400);

export function parseRequest(body: unknown, now: Date): ActivationRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad();
  const keys = Object.keys(body);
  if (keys.length !== FIELDS.length || !FIELDS.every((k) => keys.includes(k))) throw bad();
  const b = body as Record<string, unknown>;
  if (typeof b.ammaUserId !== "number" || !Number.isSafeInteger(b.ammaUserId) || b.ammaUserId <= 0) throw bad();
  if (typeof b.taskKey !== "string" || !/^[a-z0-9:_-]{1,80}$/.test(b.taskKey)) throw bad();
  for (const k of ["completionId", "idempotencyKey"] as const) if (typeof b[k] !== "string" || !/^[\x21-\x7e]{8,100}$/.test(b[k] as string)) throw bad();
  if (typeof b.completedAt !== "string" || !ISO.test(b.completedAt)) throw bad();
  const at = Date.parse(b.completedAt);
  if (!Number.isFinite(at) || at < now.getTime() - 30 * DAY || at > now.getTime() + 5 * 60_000) throw bad();
  return { ammaUserId: b.ammaUserId, taskKey: b.taskKey, completionId: b.completionId as string, idempotencyKey: b.idempotencyKey as string, completedAt: b.completedAt };
}
/** Field order is fixed, so the digest does not depend on how the partner ordered or spaced its JSON. */
export const digestOf = (r: ActivationRequest): string => createHash("sha256").update(JSON.stringify(FIELDS.map((k) => r[k]))).digest("hex");

// ── Views ───────────────────────────────────────────────────────────────────────────────────────────────────
export async function activationView(tx: Pick<ActivationDb, "execute">, completionRowId: number, tenantId: number, flags: Pick<ActivationFlags, "chains">): Promise<ActivationView | null> {
  const rows = rowsOf<{ cid: string; pcid: string; task_key: string; chains: string[]; chain: string | null; network: string | null; address: string | null; state: string | null; tx_hash: string | null }>(await tx.execute(sql`
    SELECT c.id AS cid, c.partner_completion_id AS pcid, t.task_key, t.chains, a.chain, a.network, a.address, a.state, a.tx_hash
    FROM partner_task_completions c JOIN partner_tasks t ON t.id = c.task_id LEFT JOIN wallet_activations a ON a.completion_id = c.id
    WHERE c.id = ${completionRowId} AND c.tenant_id = ${tenantId} ORDER BY a.id`));
  if (!rows.length) return null;
  const chains: ActivationView["chains"] = rows.filter((r) => r.chain).map((r) => ({
    chain: r.chain!, network: r.network!, address: r.address!, state: r.state === "refunded" ? "failed_final" : r.state!, ...(r.state === "confirmed" && r.tx_hash ? { txHash: r.tx_hash } : {}),
  }));
  // A chain the task lists but this server does not run is reported, never stored.
  for (const c of rows[0].chains) if (!(flags.chains as readonly string[]).includes(c)) chains.push({ chain: c, state: "skipped_chain_unavailable" });
  const states = chains.map((c) => c.state);
  const status = states.some((s) => s === "failed_final") ? "failed"
    : states.some((s) => ["reserved", "submitting", "submitted", "failed", "awaiting_budget"].includes(s)) ? "pending"
    : states.includes("confirmed") ? "confirmed" : "skipped";
  return { activationId: String(rows[0].cid), completionId: rows[0].pcid, taskKey: rows[0].task_key, status, chains };
}

/** The write-ahead audit row, inside the same transaction as the money. */
export async function auditInTx(tx: Pick<ActivationDb, "execute">, action: AuditAction, userId: number | null, detail: Record<string, unknown>, who?: { ip?: string; userAgent?: string }) {
  await tx.execute(sql`INSERT INTO audit_logs (user_id, action, detail, ip_address, user_agent) VALUES (${userId}, ${action}, ${JSON.stringify(detail)}::jsonb, ${who?.ip ?? null}, ${who?.userAgent ?? null})`);
}

// ── Intake ──────────────────────────────────────────────────────────────────────────────────────────────────
interface Plan { wallet: { id: number; address: string }; skip: boolean }

export async function submitActivation(deps: IntakeDeps, partner: PartnerContext, body: unknown, who: { ip?: string; userAgent?: string } = {}): Promise<IntakeResult> {
  const now = deps.now();
  const request = parseRequest(body, now);
  const digest = digestOf(request);
  const { flags } = deps;
  try {
    let newBalance: string | undefined;
    // A task's NFT rule is checked on-chain here, before the transaction, so a slow chain read never holds the intake lock.
    const checked = await preCheckRequirement(deps.db, deps.nftHolding, { tenantId: partner.tenantId, taskKey: request.taskKey, userId: request.ammaUserId, idempotencyKey: request.idempotencyKey });
    const result = await deps.db.transaction(async (tx) => {
      await tx.execute(INTAKE_LOCK);
      const one = async <T,>(query: ReturnType<typeof sql>) => rowsOf<T>(await tx.execute(query))[0];

      // 4. Idempotency: the same key and digest returns the original result, a different digest is a conflict.
      const prior = await one<{ id: string; request_digest: string }>(sql`SELECT id, request_digest FROM partner_task_completions WHERE tenant_id = ${partner.tenantId} AND idempotency_key = ${request.idempotencyKey}`);
      if (prior) {
        if (prior.request_digest !== digest) throw new ActivationError("IDEMPOTENCY_MISMATCH", 409);
        return { status: 200 as const, body: (await activationView(tx, Number(prior.id), partner.tenantId, flags))! };
      }

      // 4b. The business's own pause button (business-controls-v1). Enforced whenever the table exists, whatever the switches say.
      const controls = await readControls(tx, partner.tenantId);
      if (controls?.pausedAt) throw new ActivationError("BUSINESS_PAUSED", 423);

      // 5. The user exists and may use Amma custody here. One generic answer, so a partner cannot probe the allow-list.
      const user = await one<{ is_email_verified: boolean | null; signing_mode: string | null; created_at: string }>(sql`SELECT is_email_verified, signing_mode, created_at FROM users WHERE id = ${request.ammaUserId}`);
      if (!user) throw new ActivationError("NOT_ELIGIBLE", 403, false, undefined, "user_unknown");
      if (!deps.custodyAllowed(request.ammaUserId)) throw new ActivationError("NOT_ELIGIBLE", 403, false, undefined, "not_allowlisted");
      // 6. The user's own SSO sign-in created the link to this partner.
      if (!(await one(sql`SELECT 1 FROM tenant_users WHERE tenant_id = ${partner.tenantId} AND user_id = ${request.ammaUserId}`))) throw new ActivationError("NOT_ELIGIBLE", 403, false, undefined, "user_not_linked");
      // 7. Amma-held, with its phrase, no recovery freeze, verified email.
      if (user.signing_mode === "self" || !(await one(sql`SELECT 1 FROM wallet_key_escrow WHERE user_id = ${request.ammaUserId} AND kind = 'phrase' AND origin = 'custody'`))) throw new ActivationError("WALLET_NOT_AMMA_HELD", 409);
      if (await deps.frozen(request.ammaUserId)) throw new ActivationError("ACCOUNT_FROZEN", 423);
      if (user.is_email_verified !== true) throw new ActivationError("EMAIL_NOT_VERIFIED", 409);

      // 8. The task is this partner's, active and unexpired; once per user per task.
      const task = await one<{ id: string; chains: string[]; payer: "tenant" | "amma"; daily_cap: number | null; total_cap: number | null; requirement_kind: string | null; requirement_contract: string | null; requirement_network: string | null }>(sql`
        SELECT t.id, t.chains, t.payer, t.daily_cap, t.total_cap, ${REQUIREMENT_COLUMNS} FROM partner_tasks t
        WHERE t.tenant_id = ${partner.tenantId} AND t.task_key = ${request.taskKey} AND t.is_active = true AND (t.expires_at IS NULL OR t.expires_at > ${iso(now)}::timestamptz)`);
      if (!task) throw new ActivationError("TASK_UNKNOWN", 404);
      // A task Amma pays for must be capped: refuse an uncapped one even if the database check was bypassed.
      if (task.payer === "amma" && (task.daily_cap === null || task.total_cap === null)) throw new ActivationError("TASK_UNKNOWN", 404, false, undefined, "uncapped_amma_task");
      if (await one(sql`SELECT 1 FROM partner_task_completions WHERE tenant_id = ${partner.tenantId} AND task_id = ${Number(task.id)} AND user_id = ${request.ammaUserId}`)) throw new ActivationError("ALREADY_COMPLETED", 409);
      if (await one(sql`SELECT 1 FROM partner_task_completions WHERE tenant_id = ${partner.tenantId} AND partner_completion_id = ${request.completionId}`)) throw new ActivationError("COMPLETION_DUPLICATE", 409);
      // Tasks Amma pays for need an account that is at least 24 hours old (sybil guard).
      if (task.payer === "amma" && now.getTime() - new Date(user.created_at).getTime() < DAY) throw new ActivationError("ACCOUNT_TOO_NEW", 409);

      // 8b. The task's activation requirement, checked on-chain before the transaction. Nothing has been written or charged yet.
      const rule = requirementOf(task);
      if (rule.kind === "holds_nft") {
        // Only a result checked against this exact rule counts (staff may have changed it while the chain was being read).
        if (!checked || checked.contract !== rule.contract || checked.network !== rule.network) throw new ActivationError("REQUIREMENT_CHECK_UNAVAILABLE", 503, true, 30, "requirement_changed");
        if (checked.outcome === "unavailable") throw new ActivationError("REQUIREMENT_CHECK_UNAVAILABLE", 503, true, 30, checked.reason);
        if (checked.outcome !== "met") throw new ActivationError("REQUIREMENT_NOT_MET", 403, false, undefined, checked.reason);
      }

      // 9. Addresses come from Amma's own records: the user's index-0 Amma-held address on this network, never from the request.
      const plans = new Map<string, Plan>();
      for (const chain of task.chains) {
        if (!(flags.chains as readonly string[]).includes(chain)) continue;
        const wallet = await one<{ id: string; public_key: string }>(sql`SELECT id, public_key FROM user_wallets WHERE user_id = ${request.ammaUserId} AND chain = ${chain} AND network = ${flags.network} AND derivation_index = 0 AND is_active = true`);
        if (!wallet) throw new ActivationError("WALLET_NOT_AMMA_HELD", 409);
        const taken = await one(sql`SELECT 1 FROM wallet_activations WHERE chain = ${chain} AND network = ${flags.network} AND address = ${wallet.public_key} AND state IN ('awaiting_budget','reserved','submitting','submitted','confirmed','failed')`);
        plans.set(chain, { wallet: { id: Number(wallet.id), address: wallet.public_key }, skip: Boolean(taken) });
      }
      const billable = [...plans.values()].filter((p) => !p.skip);

      // 10. Caps, including rows still in flight.
      const since = iso(new Date(now.getTime() - DAY));
      const count = async (where: ReturnType<typeof sql>, join = sql``) => Number((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM wallet_activations a ${join} WHERE ${where} AND a.${sql.raw(COUNTED)}`))?.n ?? 0);
      const cap = (n: number, limit: number | null) => { if (limit !== null && n + billable.length > limit) throw new ActivationError("CAP_REACHED", 429, true, 3600); };
      if (billable.length) {
        cap(await count(sql`a.user_id = ${request.ammaUserId} AND a.created_at > ${since}::timestamptz`), flags.userDailyCap);
        const byTask = sql`JOIN partner_task_completions c ON c.id = a.completion_id`;
        cap(await count(sql`c.task_id = ${Number(task.id)} AND a.created_at > ${since}::timestamptz`, byTask), task.daily_cap);
        cap(await count(sql`c.task_id = ${Number(task.id)}`, byTask), task.total_cap);
        cap(await count(sql`a.tenant_id = ${partner.tenantId} AND a.created_at > ${since}::timestamptz`), partner.dailyCap);
        cap(await count(sql`a.chain = 'stellar' AND a.network = ${flags.network} AND a.created_at > ${since}::timestamptz`), flags.globalDailyCap);
      }

      // 11. Budget: the tenant row is locked for the check and the debit, as in checkWalletBillingTx.
      let debit: { amount: string; policyId: number; fee: string; grant: string } | undefined;
      const draws: CreditPlan[] = [];
      if (billable.length && task.payer === "tenant" && flags.businessCredits) {
        // Business credits: the platform fee was taken when the bundle was bought, so only a credit and 1.1 XLM of funding are drawn here.
        const tenant = await one<{ is_active: boolean; suspended_at: string | null }>(sql`SELECT is_active, suspended_at FROM tenants WHERE id = ${partner.tenantId} FOR UPDATE`);
        if (!tenant || !tenant.is_active || tenant.suspended_at) throw new ActivationError("ACCESS_DENIED", 403);
        const pots = await one<{ annual_credits: number; monthly_credits: number; funding_xlm: string; management_xlm: string }>(sql`
          SELECT annual_credits, monthly_credits, funding_xlm::text AS funding_xlm, management_xlm::text AS management_xlm FROM tenant_credit_balances WHERE tenant_id = ${partner.tenantId} FOR UPDATE`);
        if (!pots) throw new ActivationError("BUDGET_EXHAUSTED", 402);
        // 7 days below the 2-month floor stops new activations (learners keep their wallets); a top-up lifts it at once.
        if (floorHoldActive(controls, pots.management_xlm)) throw new ActivationError("BALANCE_BELOW_FLOOR", 402);
        const left = { annual: Number(pots.annual_credits), monthly: Number(pots.monthly_credits) };
        for (let i = 0; i < billable.length; i++) {
          const plan = nextCredit(left);
          if (!plan) throw new ActivationError("BUDGET_EXHAUSTED", 402);
          left[plan]--;
          draws.push(plan);
        }
        const grant = stroopsToXlm(flags.stellarGrantStroops * BigInt(billable.length));
        if (compareDecimalStrings(pots.funding_xlm, grant) < 0) throw new ActivationError("BUDGET_EXHAUSTED", 402);
      } else if (billable.length && task.payer === "tenant") {
        const tenant = await one<{ prepaid_xlm_balance: string; is_active: boolean; suspended_at: string | null }>(sql`SELECT prepaid_xlm_balance, is_active, suspended_at FROM tenants WHERE id = ${partner.tenantId} FOR UPDATE`);
        if (!tenant || !tenant.is_active || tenant.suspended_at) throw new ActivationError("ACCESS_DENIED", 403);
        const policy = await one<{ id: string; fee: string; acquisition: boolean; debt_limit: string }>(sql`SELECT id, new_wallet_platform_fee_xlm AS fee, acquisition_mode_enabled AS acquisition, acquisition_debt_limit_xlm AS debt_limit FROM tenant_billing_policy WHERE tenant_id = ${partner.tenantId} AND is_current = true LIMIT 1`);
        if (!policy) throw new ActivationError("BILLING_NOT_CONFIGURED", 503);
        const grant = stroopsToXlm(flags.stellarGrantStroops * BigInt(billable.length));
        const amount = addDecimalStrings(grant, policy.fee);
        // Prepaid only on mainnet. On testnet a tenant may run into the acquisition debt limit when its settings allow it.
        const floor = !flags.mainnet && partner.allowDebt && policy.acquisition ? policy.debt_limit : "0";
        if (compareDecimalStrings(addDecimalStrings(tenant.prepaid_xlm_balance, negateDecimalString(amount)), floor) < 0) throw new ActivationError("BUDGET_EXHAUSTED", 402);
        debit = { amount, policyId: Number(policy.id), fee: policy.fee, grant };
      }

      // Everything below is one unit with the checks above: completion, activation rows, debit and audit commit together or not at all.
      const completion = await one<{ id: string }>(sql`
        INSERT INTO partner_task_completions (tenant_id, task_id, user_id, api_key_id, signing_key_id, partner_completion_id, idempotency_key, request_digest, completed_at, received_at)
        VALUES (${partner.tenantId}, ${Number(task.id)}, ${request.ammaUserId}, ${partner.apiKeyId}, ${partner.signingKeyId}, ${request.completionId}, ${request.idempotencyKey}, ${digest}, ${request.completedAt}::timestamptz, ${iso(now)}::timestamptz) RETURNING id`);
      const completionId = Number(completion.id);
      let drawIndex = 0;
      for (const [chain, plan] of plans) {
        const creditPlan = plan.skip ? null : draws[drawIndex++] ?? null;
        const paidUntil = creditPlan === "annual" ? iso(annualPaidUntil(now)) : null;
        if (flags.businessCredits) {
          await tx.execute(sql`
            INSERT INTO wallet_activations (completion_id, tenant_id, user_id, wallet_id, chain, network, address, payer, grant_base_units, state, created_at, updated_at, credit_plan, management_paid_until)
            VALUES (${completionId}, ${partner.tenantId}, ${request.ammaUserId}, ${plan.wallet.id}, ${chain}, ${flags.network}, ${plan.wallet.address}, ${task.payer}, ${(plan.skip ? 0n : flags.stellarGrantStroops).toString()}::numeric,
              ${plan.skip ? "skipped_already_active" : "reserved"}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz, ${creditPlan}, ${paidUntil}::timestamptz)`);
        } else {
          await tx.execute(sql`
            INSERT INTO wallet_activations (completion_id, tenant_id, user_id, wallet_id, chain, network, address, payer, grant_base_units, state, created_at, updated_at)
            VALUES (${completionId}, ${partner.tenantId}, ${request.ammaUserId}, ${plan.wallet.id}, ${chain}, ${flags.network}, ${plan.wallet.address}, ${task.payer}, ${(plan.skip ? 0n : flags.stellarGrantStroops).toString()}::numeric,
              ${plan.skip ? "skipped_already_active" : "reserved"}, ${iso(now)}::timestamptz, ${iso(now)}::timestamptz)`);
        }
      }
      if (draws.length) {
        const annual = draws.filter((d) => d === "annual").length, monthly = draws.length - annual;
        const funding = stroopsToXlm(flags.stellarGrantStroops * BigInt(draws.length));
        await tx.execute(sql`UPDATE tenant_credit_balances SET annual_credits = annual_credits - ${annual}, monthly_credits = monthly_credits - ${monthly},
          funding_xlm = funding_xlm - ${funding}::numeric, updated_at = ${iso(now)}::timestamptz WHERE tenant_id = ${partner.tenantId}`);
        await tx.execute(sql`INSERT INTO credit_ledger (tenant_id, event, plan, annual_credits_delta, monthly_credits_delta, funding_delta_xlm, reference, idempotency_key, created_by)
          VALUES (${partner.tenantId}, 'activation_draw', ${annual && monthly ? null : draws[0]}, ${-annual}, ${-monthly}, (0 - ${funding}::numeric), ${`completion ${completionId}`}, ${`activation:${completionId}`}, 'activation')`);
      }
      if (debit) {
        const written = await writeBillingDebit(tx, {
          tenantId: partner.tenantId, eventType: "new_wallet_activation", amountXlm: negateDecimalString(debit.amount), policyVersionId: debit.policyId,
          userId: request.ammaUserId, apiKeyId: partner.apiKeyId, walletFundingSnapshot: debit.grant, platformFeeSnapshot: debit.fee, notes: `activation completion ${completionId}`, createdBy: "activation",
        });
        newBalance = written.newBalance;
        await tx.execute(sql`UPDATE wallet_activations SET billing_event_id = ${written.billingEventId} WHERE completion_id = ${completionId} AND state = 'reserved'`);
      }
      await auditInTx(tx, "activation_requested", request.ammaUserId, {
        tenantId: partner.tenantId, taskKey: request.taskKey, completionId: completionId, ...(rule.kind === "holds_nft" ? { requirement: { nft: rule.contract, network: rule.network } } : {}), chains: [...plans].map(([c, p]) => ({ chain: c, address: p.wallet.address, skipped: p.skip })), billed: debit?.amount ?? null,
        ...(draws.length ? { credits: draws } : {}),
      }, who);
      return { status: 202 as const, body: (await activationView(tx, completionId, partner.tenantId, flags))! };
    });
    // After commit, never inside the transaction: warn the partner when the debit left the balance below zero.
    if (newBalance !== undefined) maybeNotifyDeficit(partner.tenantId, newBalance).catch(() => {});
    return result;
  } catch (error) {
    if (error instanceof ActivationError) {
      await auditRejection(deps.db, partner.tenantId, error.code, error.reason ?? null, request.ammaUserId, who);
      throw error;
    }
    throw error;
  }
}

/** One audit row per tenant and code per minute, so a loop of bad requests cannot flood the log. Never throws. */
async function auditRejection(db: ActivationDb, tenantId: number, code: string, reason: string | null, userId: number, who: { ip?: string; userAgent?: string }) {
  try {
    await db.execute(sql`INSERT INTO audit_logs (user_id, action, detail, ip_address, user_agent)
      SELECT NULL::integer, 'activation_rejected', ${JSON.stringify({ tenantId, code, userId, ...(reason ? { reason } : {}) })}::jsonb, ${who.ip ?? null}, ${who.userAgent ?? null}
      WHERE NOT EXISTS (SELECT 1 FROM audit_logs WHERE action = 'activation_rejected' AND created_at > now() - interval '1 minute' AND detail->>'tenantId' = ${String(tenantId)} AND detail->>'code' = ${code} AND COALESCE(detail->>'reason', '') = ${reason ?? ''})`);
  } catch { /* a rejection must never turn into a 500 because the log is unavailable */ }
}


