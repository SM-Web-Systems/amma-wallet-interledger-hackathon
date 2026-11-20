import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainStorageChecksum, type MigrationConnection } from "./chain-storage";

export const keyRecoveryVersion = "key-recovery-v1";
export const keyRecoverySql = readFileSync(join(__dirname, "key-recovery-v1.sql"), "utf8");
export const keyRecoveryChecksum = createHash("sha256").update(keyRecoverySql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const columns = await connection.rows<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='wallet_key_recovery'");
  const have = new Set(columns.map((c) => c.name));
  for (const column of ["user_id", "state", "ready_at", "cancel_token_hash", "created_at", "resolved_at"]) {
    if (!have.has(column)) throw new Error("key recovery schema drift; reconcile before continuing");
  }
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyKeyRecovery(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 4)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed chain storage migration is required");
  const chain = await connection.rows<{ checksum: string }>("SELECT checksum FROM amma_chain_migrations WHERE version='chain-storage-v1'");
  if (chain[0]?.checksum !== chainStorageChecksum) throw new Error("Reviewed chain storage migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${keyRecoveryVersion}'`);
  if (entries.length) {
    if (entries[0].checksum !== keyRecoveryChecksum) throw new Error("key recovery migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(keyRecoverySql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${keyRecoveryVersion}','${keyRecoveryChecksum}')`);
  return "applied";
}
