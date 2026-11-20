import {chainStorageChecksum,type MigrationConnection} from "../db/migrations/chain-storage";
import {paymentStorageChecksum} from "../db/migrations/xrpl-payments";
import {reconciliationStorageChecksum} from "../db/migrations/xrpl-reconciliation";
import {applyIntegrationStorage,integrationStorageChecksum} from "../db/migrations/xrpl-integration";

/** Require all released versions before invoking their existing-schema checks.
 * Caller uses a PostgreSQL READ ONLY transaction. No initialization is allowed.
 */
export async function verifyExistingStorage(connection:MigrationConnection):Promise<void>{
  const expected={"chain-storage-v1":chainStorageChecksum,"xrpl-payments-v1":paymentStorageChecksum,"xrpl-reconciliation-v1":reconciliationStorageChecksum,"xrpl-integration-v1":integrationStorageChecksum};
  const markers=await connection.rows<{version:string;checksum:string}>("SELECT version,checksum FROM amma_chain_migrations");
  if(Object.entries(expected).some(([version,checksum])=>!markers.some(marker=>marker.version===version&&marker.checksum===checksum)))throw new Error("Reviewed migration checksums required");
  // The historical chain migration always issues CREATE TABLE IF NOT EXISTS,
  // even on replay. Verify its metadata directly instead of invoking it here.
  const columns=await connection.rows<{table_name:string;column_name:string;is_nullable:string}>("SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('user_wallets','tx_history','address_book','portfolio_snapshots')");
  for(const table of ["user_wallets","tx_history","address_book","portfolio_snapshots"]){
    if(!columns.some(column=>column.table_name===table&&column.column_name==="chain"&&column.is_nullable==="NO")||!columns.some(column=>column.table_name===table&&column.column_name==="network"))throw new Error("Chain schema drift");
  }
  const constraints=await connection.rows<{conname:string}>("SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace");
  if(["user_wallets_chain_network_check","user_wallets_xrpl_no_secret","tx_history_chain_network_check","address_book_chain_network_check","portfolio_snapshots_stellar_check"].some(name=>!constraints.some(constraint=>constraint.conname===name)))throw new Error("Chain constraint drift");
  // Existing M5/M6/M7 branches are read-only once all markers are recognized.
  await applyIntegrationStorage(connection);
}
