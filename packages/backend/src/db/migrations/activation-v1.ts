import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { custodyV5Checksum, custodyV5Version } from "./custody-v5";
import type { MigrationConnection } from "./chain-storage";

export const activationV1Version = "activation-v1";
export const activationV1Sql = readFileSync(join(__dirname, "activation-v1.sql"), "utf8");
export const activationV1Checksum = createHash("sha256").update(activationV1Sql.replace(/\r\n/g, "\n")).digest("hex");

const TABLES = ["partner_signing_keys", "partner_activation_settings", "partner_tasks", "partner_task_completions", "wallet_activations", "activation_reconciliations"];
const INDEXES = ["wallet_activations_once_per_address", "idx_wallet_activations_work", "idx_wallet_activations_user", "idx_wallet_activations_tenant_day"];
const UNIQUES: [string, string][] = [
  ["partner_signing_keys", "UNIQUE(tenant_id,key_id)"],
  ["partner_task_completions", "UNIQUE(tenant_id,idempotency_key)"],
  ["partner_task_completions", "UNIQUE(tenant_id,partner_completion_id)"],
  ["partner_task_completions", "UNIQUE(tenant_id,task_id,user_id)"],
  ["wallet_activations", "UNIQUE(completion_id,chain)"],
];

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Activation schema drift; reconcile before continuing");
  const squash = (d: string) => d.replace(/\s/g, "");
  const quoted = (names: string[]) => names.map((t) => `'${t}'`).join(",");
  const tables = await connection.rows<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${quoted(TABLES)})`);
  if (tables.length !== TABLES.length) throw drift();
  const indexes = await connection.rows<{ name: string; def: string }>(`SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indisvalid AND c.relname IN (${quoted(INDEXES)})`);
  if (indexes.length !== INDEXES.length) throw drift();
  const address = indexes.find((i) => i.name === "wallet_activations_once_per_address")!;
  if (!/UNIQUE/i.test(address.def) || !squash(address.def).includes("(chain,network,address)") || !/WHERE/i.test(address.def) || !address.def.includes("'confirmed'")) throw drift();
  for (const [table, expected] of UNIQUES) {
    const rows = await connection.rows<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND contype='u'`);
    if (!rows.some((r) => squash(r.def) === expected)) throw drift();
  }
  // The state machine and the grant bound live in CHECKs: a loosened one is drift.
  const checks = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.wallet_activations'::regclass AND contype='c'");
  const joined = checks.map((c) => squash(c.def)).join("|");
  const cols = await connection.rows<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='wallet_activations' AND column_name='tx_hashes'");
  if (cols.length !== 1) throw drift();
  const taskChecks = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.partner_tasks'::regclass AND conname='partner_tasks_amma_needs_caps'");
  if (taskChecks.length !== 1 || !squash(taskChecks[0].def).includes("'amma'")) throw drift();
  for (const needle of ["'failed_final'", "'skipped_already_active'", "attempts>=0", "grant_base_units>=(0)::numeric", "'refunded'"]) if (!joined.includes(needle)) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyActivationV1(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 10)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed custody-v5 migration is required");
  const v5 = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV5Version}'`);
  if (v5[0]?.checksum !== custodyV5Checksum) throw new Error("Reviewed custody-v5 migration is required");
  const billing = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.billing_events')::text AS name");
  if (!billing[0]?.name) throw new Error("billing_events is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${activationV1Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== activationV1Checksum) throw new Error("Activation-v1 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(activationV1Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${activationV1Version}','${activationV1Checksum}')`);
  return "applied";
}
