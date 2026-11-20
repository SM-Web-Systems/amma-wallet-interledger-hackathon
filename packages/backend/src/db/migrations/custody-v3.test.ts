import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyCustody } from "./custody";
import { applyCustodyV2 } from "./custody-v2";
import { applyCustodyV3 } from "./custody-v3";
import { applyKeyEscrow } from "./key-escrow";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const run = (fn: (c: ReturnType<typeof connection>) => Promise<unknown>) => pg.transaction(tx => fn(connection(tx)));
const apply = () => pg.transaction(tx => applyCustodyV3(connection(tx)));
afterEach(async () => { await pg?.close(); });
const HASH = "0x" + "a".repeat(64);
const row = (over = "") => `INSERT INTO custody_evm_transfers(user_id,from_address,to_address,value_wei,nonce,hash,state,idempotency_key) VALUES (1,'0xa','0xb','5',0,'${HASH}','signed','key-12345678')${over}`;

describe("guarded custody-v3 storage", { timeout: 30_000 }, () => {
  it("requires custody-v2, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await migrate(pg); await run(applyKeyEscrow);
    await run(applyCustody);
    await expect(apply()).rejects.toThrow("custody-v2 migration is required");
    await run(applyCustodyV2);
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v3'")).rows).toHaveLength(1);
  });

  it("keeps hashes unique, idempotency keys unique per user, and rejects bad values", async () => {
    pg = await legacyDatabase(); await migrate(pg); await run(applyKeyEscrow); await run(applyCustody); await run(applyCustodyV2); await apply();
    await pg.exec(row());
    await expect(pg.exec(row())).rejects.toThrow();
    await expect(pg.exec(row().replace(HASH, "0x" + "b".repeat(64)))).rejects.toThrow();
    await expect(pg.exec(row().replace(HASH, "0x" + "c".repeat(64)).replace("'5'", "'0'").replace("key-12345678", "key-other-1"))).rejects.toThrow();
    await expect(pg.exec(row().replace(HASH, "0x" + "d".repeat(64)).replace("'signed'", "'weird'").replace("key-12345678", "key-other-2"))).rejects.toThrow();
  });

  it("refuses a changed checksum", async () => {
    pg = await legacyDatabase(); await migrate(pg); await run(applyKeyEscrow); await run(applyCustody); await run(applyCustodyV2); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='custody-v3'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
  });
});
