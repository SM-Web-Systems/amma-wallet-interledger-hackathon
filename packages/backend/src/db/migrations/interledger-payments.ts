import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chainStorageChecksum, type MigrationConnection } from "./chain-storage";

export const interledgerPaymentsVersion = "interledger-payments-v1";
export const interledgerPaymentsSql = readFileSync(join(__dirname, "payments-v1.sql"), "utf8");
export const interledgerPaymentsChecksum = createHash("sha256").update(interledgerPaymentsSql.replace(/\r\n/g, "\n")).digest("hex");

const tables = ["payment_accounts", "payment_ledger", "payment_documents", "payment_invoice_claims", "payment_spend_limits",
  "payment_idempotency", "payment_jobs", "payment_webhooks", "payment_wallet_addresses"];

async function verifySchema(connection: MigrationConnection) {
  const present = await connection.rows<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename IN (${tables.map(t => `'${t}'`).join(",")})`);
  const trigger = await connection.rows<{ name: string }>("SELECT tgname AS name FROM pg_trigger WHERE tgrelid=to_regclass('public.payment_ledger') AND tgname='payment_ledger_no_rewrite' AND NOT tgisinternal");
  if (present.length !== tables.length || trigger.length !== 1) throw new Error("Interledger payment schema drift; reconcile before continuing");
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyInterledgerPayments(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 2)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed chain storage migration is required");
  const chain = await connection.rows<{ checksum: string }>("SELECT checksum FROM amma_chain_migrations WHERE version='chain-storage-v1'");
  if (chain[0]?.checksum !== chainStorageChecksum) throw new Error("Reviewed chain storage migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${interledgerPaymentsVersion}'`);
  if (entries.length) {
    if (entries[0].checksum !== interledgerPaymentsChecksum) throw new Error("Interledger payment migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(interledgerPaymentsSql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${interledgerPaymentsVersion}','${interledgerPaymentsChecksum}')`);
  return "applied";
}
