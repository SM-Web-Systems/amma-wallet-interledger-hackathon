import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MigrationConnection } from "./chain-storage";
import { paymentStorageChecksum } from "./xrpl-payments";
import { reconciliationStorageChecksum } from "./xrpl-reconciliation";
import { integrationStorageChecksum } from "./xrpl-integration";

export const xrplMainnetVersion = "xrpl-mainnet-v1";
export const xrplMainnetSql = readFileSync(join(__dirname, "xrpl-mainnet-v1.sql"), "utf8");
export const xrplMainnetChecksum = createHash("sha256").update(xrplMainnetSql.replace(/\r\n/g, "\n")).digest("hex");

async function verify(connection: MigrationConnection) {
  const [row] = await connection.rows<{ def: string | null }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.xrpl_payments'::regclass AND conname='xrpl_payments_network'");
  if (!row?.def || !row.def.includes("'testnet'") || !row.def.includes("'mainnet'")) throw new Error("XRP mainnet network constraint drift; reconcile before continuing");
}

/** Needs the released payment, reconciliation and integration migrations (the custody send path uses all three). Idempotent through its marker. */
export async function applyXrplMainnet(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 2)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed chain storage migration is required");
  const markers = new Map((await connection.rows<{ version: string; checksum: string }>("SELECT version, checksum FROM amma_chain_migrations")).map((m) => [m.version, m.checksum]));
  for (const [version, checksum] of [["xrpl-payments-v1", paymentStorageChecksum], ["xrpl-reconciliation-v1", reconciliationStorageChecksum], ["xrpl-integration-v1", integrationStorageChecksum]] as const) {
    if (markers.get(version) !== checksum) throw new Error(`Reviewed ${version} marker/checksum is required`);
  }
  const existing = markers.get(xrplMainnetVersion);
  if (existing !== undefined) {
    if (existing !== xrplMainnetChecksum) throw new Error("XRP mainnet migration checksum mismatch");
    await verify(connection);
    return "already-applied";
  }
  await connection.execute(xrplMainnetSql);
  await verify(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${xrplMainnetVersion}','${xrplMainnetChecksum}')`);
  return "applied";
}
