import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { businessDepositsV1Checksum, businessDepositsV1Version } from "./business-deposits-v1";
import type { MigrationConnection } from "./chain-storage";

export const feeSweepsV1Version = "fee-sweeps-v1";
export const feeSweepsV1Sql = readFileSync(join(__dirname, "fee-sweeps-v1.sql"), "utf8");
export const feeSweepsV1Checksum = createHash("sha256").update(feeSweepsV1Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Fee sweeps schema drift; reconcile before continuing");
  const squash = (d: string) => d.replace(/\s/g, "");
  const have = new Set((await connection.rows<{ name: string }>(
    "SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='fee_sweeps'")).map((c) => c.name));
  for (const n of ["tenant_id", "network", "source_ref", "amount_xlm", "to_address", "state", "tx_hash", "tx_hashes", "deadline"]) if (!have.has(n)) throw drift();
  const once = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.fee_sweeps'::regclass AND conname='fee_sweeps_once'");
  if (once.length !== 1 || squash(once[0].def) !== "UNIQUE(network,source_ref)") throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyFeeSweepsV1(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 16)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed business-deposits-v1 migration is required");
  const deposits = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${businessDepositsV1Version}'`);
  if (deposits[0]?.checksum !== businessDepositsV1Checksum) throw new Error("Reviewed business-deposits-v1 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${feeSweepsV1Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== feeSweepsV1Checksum) throw new Error("Fee-sweeps-v1 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(feeSweepsV1Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${feeSweepsV1Version}','${feeSweepsV1Checksum}')`);
  return "applied";
}
