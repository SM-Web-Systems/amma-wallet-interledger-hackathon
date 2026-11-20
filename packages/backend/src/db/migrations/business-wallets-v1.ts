import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { creditsV1Checksum, creditsV1Version } from "./credits-v1";
import type { MigrationConnection } from "./chain-storage";

export const businessWalletsV1Version = "business-wallets-v1";
export const businessWalletsV1Sql = readFileSync(join(__dirname, "business-wallets-v1.sql"), "utf8");
export const businessWalletsV1Checksum = createHash("sha256").update(businessWalletsV1Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Business wallets schema drift; reconcile before continuing");
  const squash = (d: string) => d.replace(/\s/g, "");
  const columns = async (table: string) => new Set((await connection.rows<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}'`)).map((c) => c.name));
  const need = async (table: string, names: string[]) => { const have = await columns(table); for (const n of names) if (!have.has(n)) throw drift(); };
  await need("business_wallets", ["tenant_id", "network", "address", "sealed_secret", "provider", "retired_at"]);
  await need("fee_address_pool", ["network", "address", "tenant_id", "assigned_at"]);
  await need("wallet_activations", ["source_address"]);
  const indexes = await connection.rows<{ name: string; def: string }>("SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indisvalid AND c.relname IN ('business_wallets_one_live','fee_address_pool_one_per_tenant')");
  if (indexes.length !== 2 || indexes.some((i) => !/UNIQUE/i.test(i.def) || !/WHERE/i.test(i.def))) throw drift();
  for (const [table, name, expected] of [
    ["business_wallets", "business_wallets_address_unique", "UNIQUE(address)"],
    ["fee_address_pool", "fee_address_pool_address_unique", "UNIQUE(address)"],
  ]) {
    const rows = await connection.rows<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.${table}'::regclass AND conname='${name}'`);
    if (rows.length !== 1 || squash(rows[0].def) !== expected) throw drift();
  }
  const assigned = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.fee_address_pool'::regclass AND conname='fee_address_pool_assigned'");
  if (assigned.length !== 1) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyBusinessWalletsV1(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 13)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed credits-v1 migration is required");
  const credits = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${creditsV1Version}'`);
  if (credits[0]?.checksum !== creditsV1Checksum) throw new Error("Reviewed credits-v1 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${businessWalletsV1Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== businessWalletsV1Checksum) throw new Error("Business-wallets-v1 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(businessWalletsV1Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${businessWalletsV1Version}','${businessWalletsV1Checksum}')`);
  return "applied";
}
