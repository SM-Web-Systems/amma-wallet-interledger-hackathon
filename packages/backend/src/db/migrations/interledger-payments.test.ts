import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyInterledgerPayments } from "./interledger-payments";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const apply = () => pg.transaction(tx => applyInterledgerPayments(connection(tx)));
afterEach(async () => { await pg?.close(); });

describe("guarded Interledger payment storage", { timeout: 30_000 }, () => {
  it("requires the reviewed chain schema, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await expect(apply()).rejects.toThrow("chain storage migration is required");
    await migrate(pg);
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='interledger-payments-v1'")).rows).toHaveLength(1);
  });
  it("rolls back a rehearsal completely, which needs the SQL to run inside the caller's transaction", async () => {
    pg = await legacyDatabase(); await migrate(pg);
    await expect(pg.transaction(async tx => { await applyInterledgerPayments(connection(tx)); throw new Error("rehearsal"); })).rejects.toThrow("rehearsal");
    expect((await pg.query("SELECT to_regclass('payment_ledger') AS name")).rows[0]).toEqual({ name: null });
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='interledger-payments-v1'")).rows).toEqual([]);
  });
  it("refuses a changed checksum and a marked schema that lost its ledger immutability trigger", async () => {
    pg = await legacyDatabase(); await migrate(pg); await apply();
    await pg.exec("DROP TRIGGER payment_ledger_no_rewrite ON payment_ledger");
    await expect(apply()).rejects.toThrow("drift");
    await pg.exec("UPDATE amma_chain_migrations SET checksum='tampered' WHERE version='interledger-payments-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
  });
  it("keeps the ledger append-only after migration", async () => {
    pg = await legacyDatabase(); await migrate(pg); await apply();
    await pg.exec(`INSERT INTO payment_accounts(id,owner_id,asset_key,asset,kind,reference) VALUES
      ('00000000-0000-4000-8000-000000000001',0,'k','{}','clearing','main'),('00000000-0000-4000-8000-000000000002',1,'k','{}','customer','main');
      INSERT INTO payment_ledger(id,reference,asset_key,debit_account,credit_account,amount) VALUES
      ('00000000-0000-4000-8000-000000000003','r','k','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',5)`);
    await expect(pg.exec("UPDATE payment_ledger SET amount=6")).rejects.toThrow("append-only");
    await expect(pg.exec("DELETE FROM payment_ledger")).rejects.toThrow("append-only");
  });
});
