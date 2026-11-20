import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { custodyV2Checksum, custodyV2Version } from "./custody-v2";
import type { MigrationConnection } from "./chain-storage";

export const custodyV3Version = "custody-v3";
export const custodyV3Sql = readFileSync(join(__dirname, "custody-v3.sql"), "utf8");
export const custodyV3Checksum = createHash("sha256").update(custodyV3Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Custody schema drift; reconcile before continuing");
  const columns = await connection.rows<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='custody_evm_transfers'");
  const have = new Set(columns.map((c) => c.name));
  for (const c of ["id", "user_id", "from_address", "to_address", "value_wei", "max_fee_wei", "nonce", "hash", "state", "idempotency_key", "created_at", "updated_at"]) if (!have.has(c)) throw drift();
  const unique = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.custody_evm_transfers'::regclass AND contype='u'");
  const defs = unique.map((u) => u.def.replace(/\s/g, ""));
  if (!defs.includes("UNIQUE(hash)") || !defs.includes("UNIQUE(user_id,idempotency_key)")) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyCustodyV3(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 7)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed custody-v2 migration is required");
  const v2 = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV2Version}'`);
  if (v2[0]?.checksum !== custodyV2Checksum) throw new Error("Reviewed custody-v2 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV3Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== custodyV3Checksum) throw new Error("Custody-v3 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(custodyV3Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${custodyV3Version}','${custodyV3Checksum}')`);
  return "applied";
}
