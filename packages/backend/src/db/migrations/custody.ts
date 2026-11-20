import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainStorageChecksum, type MigrationConnection } from "./chain-storage";

export const custodyVersion = "custody-v1";
export const custodySql = readFileSync(join(__dirname, "custody-v1.sql"), "utf8");
export const custodyChecksum = createHash("sha256").update(custodySql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const columns = await connection.rows<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='welcome_funding'");
  const have = new Set(columns.map((c) => c.name));
  for (const column of ["user_id", "chain", "address", "state", "amount", "reference", "error", "attempts", "created_at", "updated_at"]) {
    if (!have.has(column)) throw new Error("Custody schema drift; reconcile before continuing");
  }
  const escrow = await connection.rows<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='wallet_key_escrow'");
  if (!escrow.some((c) => c.name === "origin")) throw new Error("Custody schema drift; reconcile before continuing");
  const escrowChecks = await connection.rows<{ name: string }>("SELECT conname AS name FROM pg_constraint WHERE conrelid='public.wallet_key_escrow'::regclass");
  if (!escrowChecks.some((c) => c.name === "wallet_key_escrow_origin_check")) throw new Error("Custody schema drift; reconcile before continuing");
  const checks = await connection.rows<{ name: string; def: string }>("SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.user_wallets'::regclass");
  if (!checks.some((c) => c.name === "user_wallets_evm_no_secret")) throw new Error("Custody schema drift; reconcile before continuing");
  if (!checks.some((c) => c.name === "user_wallets_chain_network_check" && c.def.includes("'evm'"))) throw new Error("Custody schema drift; reconcile before continuing");
  const unique = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.welcome_funding'::regclass AND contype='u'");
  if (!unique.some((u) => u.def.replace(/\s/g, "") === "UNIQUE(user_id,chain)")) throw new Error("Custody schema drift; reconcile before continuing");
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyCustody(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 5)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed chain storage migration is required");
  const chain = await connection.rows<{ checksum: string }>("SELECT checksum FROM amma_chain_migrations WHERE version='chain-storage-v1'");
  if (chain[0]?.checksum !== chainStorageChecksum) throw new Error("Reviewed chain storage migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyVersion}'`);
  if (entries.length) {
    if (entries[0].checksum !== custodyChecksum) throw new Error("Custody migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  const escrowTable = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.wallet_key_escrow')::text AS name");
  if (!escrowTable[0]?.name) throw new Error("Reviewed key escrow migration is required");
  await connection.execute(custodySql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${custodyVersion}','${custodyChecksum}')`);
  return "applied";
}
