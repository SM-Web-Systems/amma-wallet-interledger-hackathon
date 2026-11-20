import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyCustody } from "./custody";
import { applyCustodyV2 } from "./custody-v2";
import { applyCustodyV3 } from "./custody-v3";
import { applyCustodyV4 } from "./custody-v4";
import { applyCustodyV5 } from "./custody-v5";
import { applyKeyEscrow } from "./key-escrow";
import { evaluateSchema, readSchemaFacts, requiredMarkers } from "../schema-gate";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const run = (fn: (c: ReturnType<typeof connection>) => Promise<unknown>) => pg.transaction(tx => fn(connection(tx)));
const apply = () => pg.transaction(tx => applyCustodyV5(connection(tx)));
afterEach(async () => { await pg?.close(); });
const wallet = (chain: string, network: string, key = "k" + Math.random().toString(36).slice(2)) =>
  pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active) VALUES (1,$1,$2,$3,'w',false)", [chain, network, key]);
const upTo4 = async () => { pg = await legacyDatabase(); await migrate(pg); for (const a of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4]) await run(a); };

describe("guarded custody-v5 storage", { timeout: 30_000 }, () => {
  it("requires custody-v4, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await migrate(pg); for (const a of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3]) await run(a);
    await expect(apply()).rejects.toThrow("custody-v4 migration is required");
    await run(applyCustodyV4);
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v5'")).rows).toHaveLength(1);
  });

  it("allows evm/ethereum only after v5, keeps sepolia, and rejects other combinations", async () => {
    await upTo4();
    await expect(wallet("evm", "ethereum")).rejects.toThrow();
    await apply();
    await wallet("evm", "ethereum"); await wallet("evm", "sepolia");
    await wallet("stellar", "public"); await wallet("stellar", "testnet"); await wallet("xrpl", "mainnet"); await wallet("xrpl", "testnet");
    await expect(wallet("evm", "testnet")).rejects.toThrow();
    await expect(wallet("evm", "mainnet")).rejects.toThrow();
    await expect(wallet("stellar", "ethereum")).rejects.toThrow();
    await expect(wallet("bitcoin", "mainnet")).rejects.toThrow();
  });

  it("refuses a changed checksum and a drifted constraint", async () => {
    await upTo4(); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='custody-v5'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
  });
  it("refuses a database where the constraint was loosened", async () => {
    await upTo4(); await apply();
    await pg.exec("ALTER TABLE user_wallets DROP CONSTRAINT user_wallets_chain_network_check; ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_chain_network_check CHECK (chain IN ('stellar','xrpl','evm'))");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("is required by the gate wherever v4 is required", async () => {
    await upTo4();
    const facts = async () => readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);
    for (const env of [{ CUSTODY_SERVER_SIGNING: "true" }, { WELCOME_FUNDING: "1" }]) {
      expect(requiredMarkers(env)).toContain("custody-v5");
      expect(evaluateSchema(await facts(), env).problems).toContain("required migration custody-v5 has not been applied");
    }
    await apply();
    expect(evaluateSchema(await facts(), { CUSTODY_SERVER_SIGNING: "true" }).problems.filter((p) => p.includes("custody-v"))).toEqual([]);
  });
});
