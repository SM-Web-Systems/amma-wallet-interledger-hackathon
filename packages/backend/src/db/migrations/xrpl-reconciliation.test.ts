import {afterEach,describe,expect,it} from "vitest";
import type {PGlite} from "@electric-sql/pglite";
import {legacyDatabase,migrate} from "./chain-storage.test-support";
import {applyPaymentStorage} from "./xrpl-payments";
import {applyReconciliationStorage} from "./xrpl-reconciliation";
import type {MigrationConnection} from "./chain-storage";
let pg:PGlite;
const run=(apply:(connection:MigrationConnection)=>Promise<unknown>)=>pg.transaction(tx=>apply({execute:async statement=>{await tx.exec(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>(await tx.query<T>(statement)).rows}));
const setup=async()=>{pg=await legacyDatabase();await migrate(pg);await run(applyPaymentStorage);};
afterEach(async()=>{await pg?.close();});
// Each case boots a fresh WASM PostgreSQL instance; allow bounded cold-start time.
describe("reconciliation storage evolution",{timeout:30_000},()=>{
  it("requires the released payment migration rather than installing it implicitly",async()=>{
    pg=await legacyDatabase();await migrate(pg);await expect(run(applyReconciliationStorage)).rejects.toThrow("required");
    expect((await pg.query("SELECT to_regclass('xrpl_payments') AS name")).rows[0]).toEqual({name:null});
  });
  it("is additive, idempotent and retains historical payment evidence",async()=>{
    await setup();expect(await run(applyReconciliationStorage)).toBe("applied");expect(await run(applyReconciliationStorage)).toBe("already-applied");
    expect((await pg.query("SELECT count(*)::int AS n FROM users")).rows[0]).toEqual({n:2});
    expect((await pg.query("SELECT column_default FROM information_schema.columns WHERE table_name='xrpl_payments' AND column_name='broadcast_attempts'")).rows[0]).toEqual({column_default:"0"});
  });
  it("rolls back a rehearsal, including new constraints and marker",async()=>{
    await setup();await expect(pg.transaction(async tx=>{
      await applyReconciliationStorage({execute:async statement=>{await tx.exec(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>(await tx.query<T>(statement)).rows});throw new Error("rehearsal");
    })).rejects.toThrow("rehearsal");
    expect((await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name='xrpl_payments' AND column_name='lease_token'")).rows).toEqual([]);
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='xrpl-reconciliation-v1'")).rows).toEqual([]);
  });
  it("rejects unknown columns, checksum mismatch and a missing queue index",async()=>{
    await setup();await pg.exec("ALTER TABLE xrpl_payments ADD COLUMN lease_token uuid");await expect(run(applyReconciliationStorage)).rejects.toThrow("Unexpected");await pg.exec("ALTER TABLE xrpl_payments DROP COLUMN lease_token");
    await run(applyReconciliationStorage);await pg.exec("DROP INDEX idx_xrpl_payment_reconciliation_queue");await expect(run(applyReconciliationStorage)).rejects.toThrow("drift");
    await pg.exec("UPDATE amma_chain_migrations SET checksum='changed' WHERE version='xrpl-reconciliation-v1'");await expect(run(applyReconciliationStorage)).rejects.toThrow("checksum mismatch");
  });
});
