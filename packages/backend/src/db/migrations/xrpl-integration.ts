import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MigrationConnection } from "./chain-storage";
import { applyReconciliationStorage, reconciliationStorageChecksum } from "./xrpl-reconciliation";

export const integrationStorageVersion = "xrpl-integration-v1";
export const integrationStorageSql = readFileSync(join(__dirname, "xrpl-integration-v1.sql"), "utf8");
export const integrationStorageChecksum = createHash("sha256").update(integrationStorageSql.replace(/\r\n/g,"\n")).digest("hex");
async function verify(connection: MigrationConnection) {
  const columns = await connection.rows<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='xrpl_payments'");
  const constraints = await connection.rows<{conname:string}>("SELECT conname FROM pg_constraint WHERE conrelid='public.xrpl_receipt_claims'::regclass");
  const bindings=await connection.rows<{conname:string}>("SELECT conname FROM pg_constraint WHERE conrelid='public.xrpl_payments'::regclass AND conname IN ('xrpl_payments_application','xrpl_payments_application_tenant_id_fkey')");
  const indexes = await connection.rows<{indexdef:string}>("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='xrpl_payments' AND indexname IN ('idx_xrpl_payment_idempotency','idx_xrpl_payment_reference')");
  if (["application_tenant_id","application_name"].some(name=>!columns.some(row=>row.column_name===name)) ||
    bindings.length!==2 || ["xrpl_claim_intent","xrpl_claim_transaction","xrpl_claim_reference","xrpl_claim_purchase","xrpl_claim_network","xrpl_claim_hash","xrpl_receipt_claims_pkey","xrpl_receipt_claims_intent_id_fkey","xrpl_receipt_claims_application_tenant_id_fkey","xrpl_receipt_claims_user_id_fkey","xrpl_receipt_claims_api_key_id_fkey"].some(name=>!constraints.some(row=>row.conname===name)) ||
    indexes.length!==2 || indexes.some(row=>!row.indexdef.includes("COALESCE(application_tenant_id"))) throw new Error("Integration schema drift");
}
export async function applyIntegrationStorage(connection: MigrationConnection): Promise<"applied"|"already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241,2)");
  const marker=await connection.rows<{name:string|null}>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed reconciliation storage is required");
  const prerequisite=await connection.rows<{checksum:string}>("SELECT checksum FROM amma_chain_migrations WHERE version='xrpl-reconciliation-v1'");
  if(prerequisite[0]?.checksum!==reconciliationStorageChecksum)throw new Error("Reviewed reconciliation marker/checksum is required");
  await applyReconciliationStorage(connection);
  const existing=await connection.rows<{checksum:string}>("SELECT checksum FROM amma_chain_migrations WHERE version='xrpl-integration-v1'");
  if(existing.length){if(existing[0].checksum!==integrationStorageChecksum)throw new Error("Integration checksum mismatch");await verify(connection);return "already-applied";}
  await connection.execute(integrationStorageSql);await verify(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${integrationStorageVersion}','${integrationStorageChecksum}')`);
  return "applied";
}
