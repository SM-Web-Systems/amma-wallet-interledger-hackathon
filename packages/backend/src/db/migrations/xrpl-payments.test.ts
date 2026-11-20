import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyPaymentStorage } from "./xrpl-payments";

let pg: PGlite;
const apply = () => pg.transaction(tx => applyPaymentStorage({ execute: async sql => { await tx.exec(sql); }, rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows }));
afterEach(async () => { await pg?.close(); });
// Each case boots a fresh WASM PostgreSQL instance; allow bounded cold-start time.
describe("additive XRP payment storage", { timeout: 30_000 }, () => {
  it("requires the reviewed chain schema and atomically creates its own tables", async () => {
    pg = await legacyDatabase(); await expect(apply()).rejects.toThrow("required");
    await migrate(pg); expect(await apply()).toBe("applied"); expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT count(*)::int AS n FROM users")).rows[0]).toEqual({ n: 2 });
  });
  it("rejects unknown tables and changed checksums", async () => {
    pg = await legacyDatabase(); await migrate(pg);
    await pg.exec("CREATE TABLE xrpl_payments(id text)"); await expect(apply()).rejects.toThrow("Unrecognized");
    await pg.exec("DROP TABLE xrpl_payments"); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='tampered' WHERE version='xrpl-payments-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
  });
  it("rolls back a successful rehearsal without a table or marker", async () => {
    pg = await legacyDatabase(); await migrate(pg);
    await expect(pg.transaction(async tx => {
      await applyPaymentStorage({ execute: async sql => { await tx.exec(sql); }, rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows });
      throw new Error("rehearsal");
    })).rejects.toThrow("rehearsal");
    expect((await pg.query("SELECT to_regclass('xrpl_payments') AS name")).rows[0]).toEqual({ name: null });
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='xrpl-payments-v1'")).rows).toEqual([]);
  });
  it("refuses an already-marked schema that lost its source reservation index",async()=>{
    pg=await legacyDatabase();await migrate(pg);await apply();
    await pg.exec("DROP INDEX idx_xrpl_payment_active_source");await expect(apply()).rejects.toThrow("drift");
  });
});
