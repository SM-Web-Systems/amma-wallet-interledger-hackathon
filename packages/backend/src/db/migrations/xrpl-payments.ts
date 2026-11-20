import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainStorageChecksum, type MigrationConnection } from "./chain-storage";

export const paymentStorageVersion = "xrpl-payments-v1";
export const paymentStorageSql = readFileSync(join(__dirname, "xrpl-payments-v1.sql"), "utf8");
export const paymentStorageChecksum = createHash("sha256").update(paymentStorageSql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const tables = await connection.rows<{ payments: string | null; events: string | null }>("SELECT to_regclass('public.xrpl_payments')::text AS payments,to_regclass('public.xrpl_payment_events')::text AS events");
  if (!tables[0]?.payments || !tables[0]?.events) throw new Error("Payment schema drift; reconcile before continuing");
  const constraints = (await connection.rows<{ name: string }>("SELECT conname AS name FROM pg_constraint WHERE conrelid='public.xrpl_payments'::regclass")).map(row=>row.name);
  const indexes = (await connection.rows<{ name: string }>("SELECT indexname AS name FROM pg_indexes WHERE schemaname='public' AND tablename='xrpl_payments'")).map(row=>row.name);
  if (["network","state","preparation","signature","blob","hash","digest","receipt"].some(name=>!constraints.includes(`xrpl_payments_${name}`)) || ["idempotency","reference","preparation","hash","owner_source","active_source","owner"].some(name=>!indexes.includes(`idx_xrpl_payment_${name}`))) throw new Error("Payment constraint/index drift; reconcile before continuing");
}

export async function applyPaymentStorage(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 2)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed chain storage migration is required");
  const chain = await connection.rows<{ checksum: string }>("SELECT checksum FROM amma_chain_migrations WHERE version='chain-storage-v1'");
  if (chain[0]?.checksum !== chainStorageChecksum) throw new Error("Chain migration marker mismatch");
  const entries = await connection.rows<{ checksum: string }>("SELECT checksum FROM amma_chain_migrations WHERE version='xrpl-payments-v1'");
  if (entries.length) {
    if (entries[0].checksum !== paymentStorageChecksum) throw new Error("Payment migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(paymentStorageSql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${paymentStorageVersion}','${paymentStorageChecksum}')`);
  return "applied";
}
