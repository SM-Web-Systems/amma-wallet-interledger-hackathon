/**
 * Partner activation tasks, as staff register them for a business (stage 4 of the business activation plan).
 *
 * Each task has an activation requirement: "signed call only" (the partner's signed call is enough) or "holds an NFT from
 * contract X on network Y", which the intake checks on-chain before any XLM is sent (modules/activation/requirement.ts).
 * Setting an NFT rule needs activation-requirements-v1; a signed-call task works without it.
 */
import { sql } from "drizzle-orm";
import { StrKey } from "@stellar/stellar-sdk";
import type { AuditAction } from "../lib/audit";
import { rowsOf, type ActivationDb } from "../modules/activation/errors";
import { REQUIREMENT_COLUMNS, requirementOf, type TaskRequirement } from "../modules/activation/requirement";

type Db = Pick<ActivationDb, "execute" | "transaction">;
const auditInTx = async (tx: Pick<ActivationDb, "execute">, action: AuditAction, detail: Record<string, unknown>) =>
  tx.execute(sql`INSERT INTO audit_logs (user_id, action, detail) VALUES (${null}, ${action}, ${JSON.stringify(detail)}::jsonb)`);

/** --requirement=signed-call, or --requirement=nft --contract=C... --nft-network=public|testnet. */
export function parseRequirement(options: Record<string, string>): TaskRequirement {
  const kind = options.requirement ?? "signed-call";
  if (kind === "signed-call") {
    if (options.contract || options["nft-network"]) throw new Error("--contract and --nft-network only go with --requirement=nft");
    return { kind: "signed_call" };
  }
  if (kind !== "nft") throw new Error("--requirement must be signed-call or nft");
  const contract = options.contract ?? "";
  if (!StrKey.isValidContract(contract)) throw new Error("--contract=C... must be a valid Soroban contract id");
  const network = options["nft-network"];
  if (network !== "public" && network !== "testnet") throw new Error("--nft-network=public|testnet is required with --requirement=nft");
  return { kind: "holds_nft", contract, network };
}

const columns = (r: TaskRequirement) => r.kind === "holds_nft"
  ? { kind: "holds_nft", contract: r.contract, network: r.network }
  : { kind: "signed_call", contract: null, network: null };
const describe = (r: TaskRequirement) => (r.kind === "holds_nft" ? { requirement: "nft", contract: r.contract, network: r.network } : { requirement: "signed-call" });

async function requirementsApplied(db: Pick<ActivationDb, "execute">): Promise<boolean> {
  return rowsOf(await db.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'partner_tasks' AND column_name = 'requirement_kind'`)).length > 0;
}

export interface NewTask {
  tenantId: number; taskKey: string; name: string; payer: "tenant" | "amma";
  dailyCap: number | null; totalCap: number | null; requirement: TaskRequirement; by: string;
}

export async function createTask(db: Db, t: NewTask): Promise<{ id: number }> {
  if (!/^[a-z0-9:_-]{1,80}$/.test(t.taskKey)) throw new Error("Task key: lower-case letters, digits, : _ - only, at most 80");
  if (!t.name || t.name.length > 120) throw new Error("Task name is required, at most 120 characters");
  if (t.payer === "amma" && (t.dailyCap === null || t.totalCap === null)) throw new Error("A task Amma pays for needs --daily-cap and --total-cap");
  const withRule = t.requirement.kind !== "signed_call";
  if (withRule && !(await requirementsApplied(db))) throw new Error("An NFT requirement needs the activation-requirements-v1 migration first");
  return db.transaction(async (tx) => {
    const exists = rowsOf(await tx.execute(sql`SELECT 1 FROM partner_tasks WHERE tenant_id = ${t.tenantId} AND task_key = ${t.taskKey}`));
    if (exists.length) throw new Error("That business already has a task with this key; use set-requirement to change its rule");
    const r = columns(t.requirement);
    const row = rowsOf<{ id: string }>(await tx.execute(withRule
      ? sql`INSERT INTO partner_tasks (tenant_id, task_key, name, chains, payer, daily_cap, total_cap, created_by, requirement_kind, requirement_contract, requirement_network)
          VALUES (${t.tenantId}, ${t.taskKey}, ${t.name}, '{stellar}', ${t.payer}, ${t.dailyCap}, ${t.totalCap}, ${t.by}, ${r.kind}, ${r.contract}, ${r.network}) RETURNING id`
      : sql`INSERT INTO partner_tasks (tenant_id, task_key, name, chains, payer, daily_cap, total_cap, created_by)
          VALUES (${t.tenantId}, ${t.taskKey}, ${t.name}, '{stellar}', ${t.payer}, ${t.dailyCap}, ${t.totalCap}, ${t.by}) RETURNING id`))[0];
    await auditInTx(tx, "activation_task_created", { tenantId: t.tenantId, taskKey: t.taskKey, payer: t.payer, dailyCap: t.dailyCap, totalCap: t.totalCap, ...describe(t.requirement), by: t.by });
    return { id: Number(row.id) };
  });
}

export async function setTaskRequirement(db: Db, s: { tenantId: number; taskKey: string; requirement: TaskRequirement; by: string }): Promise<{ changed: boolean }> {
  if (!(await requirementsApplied(db))) throw new Error("Setting a requirement needs the activation-requirements-v1 migration first");
  return db.transaction(async (tx) => {
    const current = rowsOf<{ id: string; requirement_kind: string | null; requirement_contract: string | null; requirement_network: string | null }>(await tx.execute(sql`
      SELECT t.id, ${REQUIREMENT_COLUMNS} FROM partner_tasks t WHERE t.tenant_id = ${s.tenantId} AND t.task_key = ${s.taskKey} FOR UPDATE`))[0];
    if (!current) throw new Error("No task with this key for that business");
    const before = requirementOf(current);
    if (JSON.stringify(columns(before)) === JSON.stringify(columns(s.requirement))) return { changed: false };
    const r = columns(s.requirement);
    await tx.execute(sql`UPDATE partner_tasks SET requirement_kind = ${r.kind}, requirement_contract = ${r.contract}, requirement_network = ${r.network} WHERE id = ${Number(current.id)}`);
    await auditInTx(tx, "activation_task_requirement_set", { tenantId: s.tenantId, taskKey: s.taskKey, before: describe(before), after: describe(s.requirement), by: s.by });
    return { changed: true };
  });
}

export async function listTasks(db: Pick<ActivationDb, "execute">, tenantId: number) {
  const rows = rowsOf<{ task_key: string; name: string; payer: string; daily_cap: number | null; total_cap: number | null; is_active: boolean; requirement_kind: string | null; requirement_contract: string | null; requirement_network: string | null }>(await db.execute(sql`
    SELECT t.task_key, t.name, t.payer, t.daily_cap, t.total_cap, t.is_active, ${REQUIREMENT_COLUMNS} FROM partner_tasks t WHERE t.tenant_id = ${tenantId} ORDER BY t.id`));
  return rows.map((r) => ({ taskKey: r.task_key, name: r.name, payer: r.payer, dailyCap: r.daily_cap, totalCap: r.total_cap, active: r.is_active, ...describe(requirementOf(r)) }));
}
