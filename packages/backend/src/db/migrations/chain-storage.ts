import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const chainStorageVersion = "chain-storage-v1";
export const chainStorageSql = readFileSync(join(__dirname, "chain-storage-v1.sql"), "utf8");
export const chainStorageChecksum = createHash("sha256").update(chainStorageSql.replace(/\r\n/g, "\n")).digest("hex");

// A deliberately small interface shared by postgres-js and the isolated test DB.
export interface MigrationConnection {
  execute(statement: string): Promise<void>;
  rows<T extends Record<string, unknown>>(statement: string): Promise<T[]>;
}

/** Caller must own the transaction. Failure rolls back DDL, data and marker. */
export async function applyChainStorage(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 2)");
  await connection.execute("CREATE TABLE IF NOT EXISTS amma_chain_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const entries = await connection.rows<{ checksum: string }>("SELECT checksum FROM amma_chain_migrations WHERE version='chain-storage-v1'");
  if (entries.length) {
    if (entries[0].checksum !== chainStorageChecksum) throw new Error("Chain migration checksum mismatch; reconcile deployment artifacts");
    return "already-applied";
  }
  await connection.execute(chainStorageSql);
  // Both values are application constants, never caller-provided SQL.
  await connection.execute(`INSERT INTO amma_chain_migrations(version, checksum) VALUES ('${chainStorageVersion}', '${chainStorageChecksum}')`);
  return "applied";
}
