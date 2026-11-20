import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyKeyEscrow } from "./key-escrow";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const apply = () => pg.transaction(tx => applyKeyEscrow(connection(tx)));
afterEach(async () => { await pg?.close(); });

describe("guarded key escrow storage", { timeout: 30_000 }, () => {
  it("requires the reviewed chain schema, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await expect(apply()).rejects.toThrow("chain storage migration is required");
    await migrate(pg);
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='key-escrow-v1'")).rows).toHaveLength(1);
  });

  it("rolls back a rehearsal completely", async () => {
    pg = await legacyDatabase(); await migrate(pg);
    await expect(pg.transaction(async tx => { await applyKeyEscrow(connection(tx)); throw new Error("rehearsal"); })).rejects.toThrow("rehearsal");
    expect((await pg.query("SELECT to_regclass('wallet_key_escrow') AS name")).rows[0]).toEqual({ name: null });
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='key-escrow-v1'")).rows).toEqual([]);
  });

  it("refuses a changed checksum and a marked schema that lost its table", async () => {
    pg = await legacyDatabase(); await migrate(pg); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='tampered' WHERE version='key-escrow-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
    await pg.exec("UPDATE amma_chain_migrations SET checksum=(SELECT checksum FROM amma_chain_migrations WHERE version='chain-storage-v1') WHERE version='key-escrow-v1'");
    await pg.exec("DROP TABLE wallet_key_escrow");
    await expect(apply()).rejects.toThrow(/checksum mismatch|drift/);
  });

  it("keeps one copy per user and kind, only known kinds, and removes copies with the user", async () => {
    pg = await legacyDatabase(); await migrate(pg); await apply();
    const sealed = "v1.local." + "a".repeat(60);
    await pg.exec(`INSERT INTO wallet_key_escrow(user_id,kind,sealed,provider) VALUES (1,'phrase','${sealed}','local')`);
    await expect(pg.exec(`INSERT INTO wallet_key_escrow(user_id,kind,sealed,provider) VALUES (1,'phrase','${sealed}','local')`)).rejects.toThrow();
    await expect(pg.exec(`INSERT INTO wallet_key_escrow(user_id,kind,sealed,provider) VALUES (1,'other','${sealed}','local')`)).rejects.toThrow();
    await expect(pg.exec(`INSERT INTO wallet_key_escrow(user_id,kind,sealed,provider) VALUES (1,'stellar-secret','short','local')`)).rejects.toThrow();
    await pg.exec("DELETE FROM users WHERE id=1");
    expect((await pg.query("SELECT count(*)::int AS n FROM wallet_key_escrow")).rows[0]).toEqual({ n: 0 });
  });
});
