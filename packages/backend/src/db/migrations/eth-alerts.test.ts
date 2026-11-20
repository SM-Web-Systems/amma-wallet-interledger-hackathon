import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyCustody } from "./custody";
import { applyCustodyV2 } from "./custody-v2";
import { applyCustodyV3 } from "./custody-v3";
import { applyCustodyV4 } from "./custody-v4";
import { applyCustodyV5 } from "./custody-v5";
import { applyEthAlerts } from "./eth-alerts";
import { applyKeyEscrow } from "./key-escrow";
import { evaluateSchema, readSchemaFacts, requiredMarkers } from "../schema-gate";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const run = (fn: (c: ReturnType<typeof connection>) => Promise<unknown>) => pg.transaction((tx) => fn(connection(tx)));
const apply = () => pg.transaction((tx) => applyEthAlerts(connection(tx)));
afterEach(async () => { await pg?.close(); });
const upTo5 = async () => { pg = await legacyDatabase(); await migrate(pg); for (const a of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4, applyCustodyV5]) await run(a); };
const mig = (p: string[]) => p.filter((x) => /migration|checksum|marker/.test(x));
const HASH = "0x" + "a".repeat(64);
const ADDR = "0x" + "b".repeat(40);
const insert = (key = "external:0", to = ADDR) => pg.query(
  "INSERT INTO eth_incoming_alerts (user_id, network, to_address, from_address, tx_hash, event_key, asset, value) VALUES (1,'ethereum',$1,$1,$2,$3,'ETH','0.5')", [to, HASH, key]);

describe("guarded eth-alerts-v1 storage", { timeout: 30_000 }, () => {
  it("requires custody-v5, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await migrate(pg); for (const a of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4]) await run(a);
    await expect(apply()).rejects.toThrow("custody-v5 migration is required");
    await run(applyCustodyV5);
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='eth-alerts-v1'")).rows).toHaveLength(1);
  });

  it("dedupes the same event and wallet, allows other events, and checks shapes", async () => {
    await upTo5(); await apply();
    await insert();
    await expect(insert()).rejects.toThrow();
    await insert("external:1"); await insert("external:0", "0x" + "c".repeat(40));
    await expect(pg.query("INSERT INTO eth_incoming_alerts (user_id, network, to_address, tx_hash, event_key, asset, value) VALUES (1,'mainnet',$1,$2,'k','ETH','1')", [ADDR, HASH])).rejects.toThrow();
    await expect(pg.query("INSERT INTO eth_incoming_alerts (user_id, network, to_address, tx_hash, event_key, asset, value) VALUES (1,'ethereum','0xABC',$1,'k','ETH','1')", [HASH])).rejects.toThrow();
  });

  it("refuses a changed checksum and a dropped unique constraint", async () => {
    await upTo5(); await apply();
    await pg.exec("ALTER TABLE eth_incoming_alerts DROP CONSTRAINT eth_incoming_alerts_event_key");
    await expect(apply()).rejects.toThrow("schema drift");
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='eth-alerts-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
  });

  it("is required by the schema gate only when ETH_ALERTS=on", async () => {
    await upTo5();
    const facts = async () => readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);
    expect(requiredMarkers({ CUSTODY_SERVER_SIGNING: "true" })).not.toContain("eth-alerts-v1");
    expect(requiredMarkers({ ETH_ALERTS: "true" })).not.toContain("eth-alerts-v1");
    expect(requiredMarkers({})).not.toContain("eth-alerts-v1");
    expect(evaluateSchema(await facts(), {}).problems.filter((p) => p.includes("eth-alerts"))).toEqual([]);
    const env = { ETH_ALERTS: "on" };
    expect(requiredMarkers(env)).toEqual(["chain-storage-v1", "custody-v1", "custody-v2", "custody-v3", "custody-v4", "custody-v5", "eth-alerts-v1"]);
    expect(mig(evaluateSchema(await facts(), env).problems)).toEqual(["required migration eth-alerts-v1 has not been applied"]);
    // with server signing too, custody markers are not listed twice
    expect(requiredMarkers({ ...env, CUSTODY_SERVER_SIGNING: "true" })).toEqual(["chain-storage-v1", "custody-v1", "custody-v2", "custody-v3", "custody-v4", "custody-v5", "eth-alerts-v1"]);
    await apply();
    expect(mig(evaluateSchema(await facts(), env).problems)).toEqual([]);
    // a marker with the wrong checksum is caught by the gate
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='eth-alerts-v1'");
    expect(mig(evaluateSchema(await facts(), env).problems)).toEqual(["checksum mismatch for eth-alerts-v1"]);
  });
});
