import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import type {MigrationConnection} from "./chain-storage";
import {applyPaymentStorage,paymentStorageChecksum} from "./xrpl-payments";
export const reconciliationStorageVersion="xrpl-reconciliation-v1";
export const reconciliationStorageSql=readFileSync(join(__dirname,"xrpl-reconciliation-v1.sql"),"utf8");
export const reconciliationStorageChecksum=createHash("sha256").update(reconciliationStorageSql.replace(/\r\n/g,"\n")).digest("hex");
async function verify(connection:MigrationConnection){
  const columns=await connection.rows<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='xrpl_payments'");
  const required=["lease_token","lease_expires_at","next_reconcile_at","reconcile_attempts","reconcile_failures","broadcast_attempts","last_broadcast_at","last_checked_ledger","last_checked_ledger_hash","reconciliation_evidence"];
  const constraints=await connection.rows<{conname:string}>("SELECT conname FROM pg_constraint WHERE conrelid='public.xrpl_payments'::regclass");
  const indexes=await connection.rows<{indexname:string}>("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='xrpl_payments'");
  if(required.some(name=>!columns.some(row=>row.column_name===name))||["xrpl_payments_expiry","xrpl_payments_lease","xrpl_payments_retries"].some(name=>!constraints.some(row=>row.conname===name))||!indexes.some(row=>row.indexname==="idx_xrpl_payment_reconciliation_queue"))throw new Error("Reconciliation schema drift");
}
export async function applyReconciliationStorage(connection:MigrationConnection):Promise<"applied"|"already-applied">{
  await connection.execute("SELECT pg_advisory_xact_lock(731241,2)");
  const marker=await connection.rows<{name:string|null}>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if(!marker[0]?.name)throw new Error("Reviewed payment storage is required");
  const prerequisite=await connection.rows<{checksum:string}>("SELECT checksum FROM amma_chain_migrations WHERE version='xrpl-payments-v1'");
  if(prerequisite[0]?.checksum!==paymentStorageChecksum)throw new Error("Reviewed payment storage marker/checksum is required");
  await applyPaymentStorage(connection); // Only verifies the already-marked prerequisite.
  const existing=await connection.rows<{checksum:string}>("SELECT checksum FROM amma_chain_migrations WHERE version='xrpl-reconciliation-v1'");
  if(existing.length){if(existing[0].checksum!==reconciliationStorageChecksum)throw new Error("Reconciliation checksum mismatch");await verify(connection);return "already-applied";}
  await connection.execute(reconciliationStorageSql);await verify(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${reconciliationStorageVersion}','${reconciliationStorageChecksum}')`);
  return "applied";
}
