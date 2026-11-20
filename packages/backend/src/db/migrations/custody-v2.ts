import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { custodyChecksum, custodyVersion } from "./custody";
import type { MigrationConnection } from "./chain-storage";

export const custodyV2Version = "custody-v2";
export const custodyV2Sql = readFileSync(join(__dirname, "custody-v2.sql"), "utf8");
export const custodyV2Checksum = createHash("sha256").update(custodyV2Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Custody schema drift; reconcile before continuing");
  const columns = await connection.rows<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='user_wallets'");
  if (!columns.some((c) => c.name === "derivation_index")) throw drift();
  const checks = await connection.rows<{ name: string }>("SELECT conname AS name FROM pg_constraint WHERE conrelid='public.user_wallets'::regclass");
  if (!checks.some((c) => c.name === "user_wallets_derivation_index_check")) throw drift();
  const indexes = await connection.rows<{ name: string }>("SELECT indexname AS name FROM pg_indexes WHERE schemaname='public' AND tablename='user_wallets'");
  if (!indexes.some((i) => i.name === "idx_user_wallets_derivation")) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyCustodyV2(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 6)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed custody-v1 migration is required");
  const v1 = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyVersion}'`);
  if (v1[0]?.checksum !== custodyChecksum) throw new Error("Reviewed custody-v1 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV2Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== custodyV2Checksum) throw new Error("Custody-v2 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(custodyV2Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${custodyV2Version}','${custodyV2Checksum}')`);
  return "applied";
}
