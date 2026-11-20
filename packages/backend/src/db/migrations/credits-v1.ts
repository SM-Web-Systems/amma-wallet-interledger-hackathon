import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activationV1Checksum, activationV1Version } from "./activation-v1";
import type { MigrationConnection } from "./chain-storage";

export const creditsV1Version = "credits-v1";
export const creditsV1Sql = readFileSync(join(__dirname, "credits-v1.sql"), "utf8");
export const creditsV1Checksum = createHash("sha256").update(creditsV1Sql.replace(/\r\n/g, "\n")).digest("hex");

const NEW_BUNDLES: [string, string, number, string][] = [
  ["monthly-100", "monthly", 100, "340.0000000"], ["monthly-200", "monthly", 200, "680.0000000"],
  ["monthly-500", "monthly", 500, "1700.0000000"], ["monthly-1000", "monthly", 1000, "3400.0000000"],
  ["annual-100", "annual", 100, "410.0000000"], ["annual-200", "annual", 200, "820.0000000"],
  ["annual-500", "annual", 500, "2050.0000000"], ["annual-1000", "annual", 1000, "4100.0000000"],
];

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Credits schema drift; reconcile before continuing");
  const squash = (d: string) => d.replace(/\s/g, "");
  const columns = async (table: string) => new Set((await connection.rows<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}'`)).map((c) => c.name));
  const need = async (table: string, names: string[]) => { const have = await columns(table); for (const n of names) if (!have.has(n)) throw drift(); };
  await need("bundle_catalog", ["plan", "users"]);
  await need("tenant_credit_balances", ["tenant_id", "annual_credits", "monthly_credits", "funding_xlm", "management_xlm", "registration_fee_waived", "registration_fee_paid_at"]);
  await need("credit_ledger", ["tenant_id", "event", "plan", "annual_credits_delta", "monthly_credits_delta", "funding_delta_xlm", "management_delta_xlm", "fee_xlm", "idempotency_key", "created_by"]);
  await need("wallet_activations", ["credit_plan", "management_paid_until", "deleted_at"]);
  const unique = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.credit_ledger'::regclass AND conname='credit_ledger_once'");
  if (unique.length !== 1 || squash(unique[0].def) !== "UNIQUE(tenant_id,idempotency_key)") throw drift();
  for (const [table, name] of [["bundle_catalog", "bundle_catalog_plan_users"], ["wallet_activations", "wallet_activations_credit_plan"]]) {
    const rows = await connection.rows<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND conname='${name}'`);
    if (rows.length !== 1) throw drift();
  }
  // Non-negative credits and funding live in CHECKs: a loosened one is drift.
  const checks = (await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.tenant_credit_balances'::regclass AND contype='c'")).map((c) => squash(c.def)).join("|");
  for (const needle of ["annual_credits>=0", "monthly_credits>=0", "funding_xlm>=(0)::numeric"]) if (!checks.includes(needle)) throw drift();
  // The prices are the owner's decision: a changed price is drift, not a silent repricing.
  const bundles = await connection.rows<{ slug: string; plan: string; users: number; price: string }>(
    `SELECT slug, plan, users, price_xlm::text AS price FROM bundle_catalog WHERE slug IN (${NEW_BUNDLES.map(([s]) => `'${s}'`).join(",")})`);
  for (const [slug, plan, users, price] of NEW_BUNDLES) {
    const row = bundles.find((b) => b.slug === slug);
    if (!row || row.plan !== plan || Number(row.users) !== users || row.price !== price) throw drift();
  }
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyCreditsV1(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 12)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed activation-v1 migration is required");
  const activation = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${activationV1Version}'`);
  if (activation[0]?.checksum !== activationV1Checksum) throw new Error("Reviewed activation-v1 migration is required");
  const catalog = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.bundle_catalog')::text AS name");
  if (!catalog[0]?.name) throw new Error("bundle_catalog is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${creditsV1Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== creditsV1Checksum) throw new Error("Credits-v1 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(creditsV1Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${creditsV1Version}','${creditsV1Checksum}')`);
  return "applied";
}
