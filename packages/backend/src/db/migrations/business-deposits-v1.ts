import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { businessWalletsV1Checksum, businessWalletsV1Version } from "./business-wallets-v1";
import type { MigrationConnection } from "./chain-storage";

export const businessDepositsV1Version = "business-deposits-v1";
export const businessDepositsV1Sql = readFileSync(join(__dirname, "business-deposits-v1.sql"), "utf8");
export const businessDepositsV1Checksum = createHash("sha256").update(businessDepositsV1Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Business deposits schema drift; reconcile before continuing");
  const squash = (d: string) => d.replace(/\s/g, "");
  const columns = async (table: string) => new Set((await connection.rows<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}'`)).map((c) => c.name));
  const need = async (table: string, names: string[]) => { const have = await columns(table); for (const n of names) if (!have.has(n)) throw drift(); };
  await need("business_deposits", ["tenant_id", "network", "operation_id", "tx_hash", "amount_xlm", "state", "held_reason", "fee_due_xlm", "credit_ledger_id"]);
  await need("business_wallets", ["deposit_cursor"]);
  const once = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.business_deposits'::regclass AND conname='business_deposits_once'");
  if (once.length !== 1 || squash(once[0].def) !== "UNIQUE(network,operation_id)") throw drift();
  const shape = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.business_deposits'::regclass AND conname='business_deposits_shape'");
  if (shape.length !== 1 || !shape[0].def.includes("credited")) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyBusinessDepositsV1(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 14)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed business-wallets-v1 migration is required");
  const wallets = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${businessWalletsV1Version}'`);
  if (wallets[0]?.checksum !== businessWalletsV1Checksum) throw new Error("Reviewed business-wallets-v1 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${businessDepositsV1Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== businessDepositsV1Checksum) throw new Error("Business-deposits-v1 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(businessDepositsV1Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${businessDepositsV1Version}','${businessDepositsV1Checksum}')`);
  return "applied";
}
