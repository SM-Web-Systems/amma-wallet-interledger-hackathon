import { afterEach,describe,expect,it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase,migrate } from "./chain-storage.test-support";
import { applyPaymentStorage } from "./xrpl-payments";
import { applyReconciliationStorage } from "./xrpl-reconciliation";
import { applyIntegrationStorage } from "./xrpl-integration";
import type { MigrationConnection } from "./chain-storage";
let pg:PGlite;
const run=(apply:(connection:MigrationConnection)=>Promise<unknown>)=>pg.transaction(tx=>apply({execute:async statement=>{await tx.exec(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>(await tx.query<T>(statement)).rows}));
const setup=async()=>{pg=await legacyDatabase();await migrate(pg);await run(applyPaymentStorage);await run(applyReconciliationStorage);};
afterEach(async()=>{await pg?.close();});
// Each case boots a fresh WASM PostgreSQL instance; allow bounded cold-start time.
describe("integration migration retains financial evidence and guards scope/claims",{timeout:30_000},()=>{
  it("requires a reviewed reconciliation marker rather than installing prerequisites",async()=>{
    pg=await legacyDatabase();await migrate(pg);await run(applyPaymentStorage);await expect(run(applyIntegrationStorage)).rejects.toThrow("required");
  });
  it("backfills existing personal scope as null, is idempotent and preserves old records",async()=>{
    await setup();await pg.exec("INSERT INTO user_wallets(id,user_id,name,public_key,chain,network) VALUES(1,1,'Public XRP','public-fixture','xrpl','testnet');INSERT INTO xrpl_payments(id,user_id,wallet_id,idempotency_key,request_digest,reference,source,request) VALUES('00000000-0000-4000-8000-000000000001',1,1,'00000000-0000-4000-8000-000000000002',repeat('a',64),'00000000-0000-4000-8000-000000000003','public-fixture','{}')");
    expect(await run(applyIntegrationStorage)).toBe("applied");expect(await run(applyIntegrationStorage)).toBe("already-applied");
    expect((await pg.query("SELECT application_tenant_id,application_name,state,request FROM xrpl_payments")).rows).toEqual([{application_tenant_id:null,application_name:null,state:"awaiting_approval",request:{}}]);
    for(const assignments of ["application_name='orphan'","application_tenant_id=1","application_tenant_id=null,application_name='orphan'"])await expect(pg.exec(`UPDATE xrpl_payments SET ${assignments}`)).rejects.toThrow();
  });
  it("rolls a rehearsal back without changing released storage or markers",async()=>{
    await setup();await expect(pg.transaction(async tx=>{
      await applyIntegrationStorage({execute:async statement=>{await tx.exec(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>(await tx.query<T>(statement)).rows});throw new Error("rehearsal");
    })).rejects.toThrow("rehearsal");
    expect((await pg.query("SELECT to_regclass('xrpl_receipt_claims') AS name")).rows[0]).toEqual({name:null});
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='xrpl-integration-v1'")).rows).toEqual([]);
    expect((await pg.query<{indexdef:string}>("SELECT indexdef FROM pg_indexes WHERE indexname='idx_xrpl_payment_idempotency'")).rows[0].indexdef).not.toContain("application_tenant_id");
  });
  it("rejects unmarked schema, checksum changes and weakened uniqueness",async()=>{
    await setup();await pg.exec("ALTER TABLE xrpl_payments ADD COLUMN application_name text");await expect(run(applyIntegrationStorage)).rejects.toThrow("Unexpected");await pg.exec("ALTER TABLE xrpl_payments DROP COLUMN application_name");
    await run(applyIntegrationStorage);await pg.exec("DROP INDEX idx_xrpl_payment_reference;CREATE UNIQUE INDEX idx_xrpl_payment_reference ON xrpl_payments(user_id,reference)");await expect(run(applyIntegrationStorage)).rejects.toThrow("drift");
    await pg.exec("UPDATE amma_chain_migrations SET checksum='changed' WHERE version='xrpl-integration-v1'");await expect(run(applyIntegrationStorage)).rejects.toThrow("checksum mismatch");
  });
});
