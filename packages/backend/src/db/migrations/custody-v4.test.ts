import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyCustody } from "./custody";
import { applyCustodyV2 } from "./custody-v2";
import { applyCustodyV3 } from "./custody-v3";
import { applyCustodyV4 } from "./custody-v4";
import { applyKeyEscrow } from "./key-escrow";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const run = (fn: (c: ReturnType<typeof connection>) => Promise<unknown>) => pg.transaction(tx => fn(connection(tx)));
const apply = () => pg.transaction(tx => applyCustodyV4(connection(tx)));
afterEach(async () => { await pg?.close(); });
const SEALED = "x".repeat(60);
const insert = (kind: string, origin: string) => pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,$1,$2,'local',$3)", [kind, SEALED, origin]);
const upTo3 = async () => { pg = await legacyDatabase(); await migrate(pg); await run(applyKeyEscrow); await run(applyCustody); await run(applyCustodyV2); await run(applyCustodyV3); };

describe("guarded custody-v4 storage", { timeout: 30_000 }, () => {
  it("requires custody-v3, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await migrate(pg); await run(applyKeyEscrow); await run(applyCustody); await run(applyCustodyV2);
    await expect(apply()).rejects.toThrow("custody-v3 migration is required");
    await run(applyCustodyV3);
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v4'")).rows).toHaveLength(1);
  });

  it("allows import escrow rows only after v4, and keeps rejecting other kinds and origins", async () => {
    await upTo3();
    await expect(insert("import:evm:0x" + "a".repeat(40), "import")).rejects.toThrow();
    await apply();
    await insert("import:evm:0x" + "a".repeat(40), "import");
    await insert("import:xrpl:rHfsP8wmWDEvSvBZu4VsF9BUB6wqXDo4xU", "import");
    await insert("phrase", "custody");
    await expect(insert("import:bitcoin:abcdefghijklmnopqrstuv", "import")).rejects.toThrow();
    await expect(insert("import:evm:bad address", "import")).rejects.toThrow();
    await expect(insert("other", "import")).rejects.toThrow();
    await expect(insert("stellar-secret", "elsewhere")).rejects.toThrow();
  });

  it("refuses a changed checksum", async () => {
    await upTo3(); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='custody-v4'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
  });
});

describe("custody-v4 schema verification", { timeout: 30_000 }, () => {
  it("refuses a database where another CHECK on kind remains", async () => {
    await upTo3(); await apply();
    await pg.exec("ALTER TABLE wallet_key_escrow ADD CONSTRAINT extra_kind CHECK (kind <> 'zzz')");
    await expect(apply()).rejects.toThrow("schema drift");
  });
  it("refuses a loosened origin check", async () => {
    await upTo3(); await apply();
    await pg.exec("ALTER TABLE wallet_key_escrow DROP CONSTRAINT wallet_key_escrow_origin_check; ALTER TABLE wallet_key_escrow ADD CONSTRAINT wallet_key_escrow_origin_check CHECK (origin IN ('client','custody','import','other'))");
    await expect(apply()).rejects.toThrow("schema drift");
  });
});
