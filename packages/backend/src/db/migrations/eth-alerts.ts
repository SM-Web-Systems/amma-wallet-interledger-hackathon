import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { custodyV5Checksum, custodyV5Version } from "./custody-v5";
import type { MigrationConnection } from "./chain-storage";

export const ethAlertsVersion = "eth-alerts-v1";
export const ethAlertsSql = readFileSync(join(__dirname, "eth-alerts-v1.sql"), "utf8");
export const ethAlertsChecksum = createHash("sha256").update(ethAlertsSql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Eth alerts schema drift; reconcile before continuing");
  const columns = await connection.rows<{ name: string }>("SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='eth_incoming_alerts'");
  const have = new Set(columns.map((c) => c.name));
  for (const c of ["id", "user_id", "network", "to_address", "from_address", "tx_hash", "event_key", "asset", "value", "created_at", "seen_at"]) if (!have.has(c)) throw drift();
  const unique = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.eth_incoming_alerts'::regclass AND contype='u'");
  if (!unique.some((u) => u.def.replace(/\s/g, "") === "UNIQUE(network,tx_hash,event_key,to_address)")) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyEthAlerts(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 11)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed custody-v5 migration is required");
  const v5 = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV5Version}'`);
  if (v5[0]?.checksum !== custodyV5Checksum) throw new Error("Reviewed custody-v5 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${ethAlertsVersion}'`);
  if (entries.length) {
    if (entries[0].checksum !== ethAlertsChecksum) throw new Error("Eth-alerts migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(ethAlertsSql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${ethAlertsVersion}','${ethAlertsChecksum}')`);
  return "applied";
}
