import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyCustody } from "./custody";
import { applyCustodyV2, custodyV2Checksum } from "./custody-v2";
import { applyKeyEscrow } from "./key-escrow";
import { evaluateSchema, readSchemaFacts } from "../schema-gate";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const v1 = () => pg.transaction(tx => applyCustody(connection(tx)));
const apply = () => pg.transaction(tx => applyCustodyV2(connection(tx)));
const base = async () => { pg = await legacyDatabase(); await migrate(pg); await pg.transaction(tx => applyKeyEscrow(connection(tx))); await v1(); };
afterEach(async () => { await pg?.close(); });
const w = (user: number, chain: string, network: string, key: string, extra = "", name = "w") =>
  `INSERT INTO user_wallets(user_id,chain,name,public_key,network${extra ? ",derivation_index" : ""}) VALUES (${user},'${chain}','${name}','${key}','${network}'${extra ? "," + extra : ""})`;

describe("guarded custody-v2 storage", { timeout: 30_000 }, () => {
  it("requires custody-v1, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await migrate(pg); await pg.transaction(tx => applyKeyEscrow(connection(tx)));
    await expect(apply()).rejects.toThrow("custody-v1 migration is required");
    await v1();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v2'")).rows).toHaveLength(1);
  });

  it("limits the derivation index to 0..9 and keeps it unique per user, chain and network", async () => {
    await base(); await apply();
    await pg.exec(w(1, "xrpl", "testnet", "rA", "0"));
    await pg.exec(w(1, "xrpl", "testnet", "rB", "9"));
    await expect(pg.exec(w(1, "xrpl", "testnet", "rC", "10"))).rejects.toThrow();
    await expect(pg.exec(w(1, "xrpl", "testnet", "rD", "-1"))).rejects.toThrow();
    await expect(pg.exec(w(1, "xrpl", "testnet", "rE", "0"))).rejects.toThrow();
    await pg.exec(w(2, "xrpl", "testnet", "rF", "0"));
    await pg.exec(w(1, "evm", "sepolia", "0xa", "0"));
    await pg.exec(w(1, "xrpl", "testnet", "rG"));
    await pg.exec(w(1, "xrpl", "testnet", "rH"));
  });

  it("backfills index 0 on the oldest row per user, chain and network, for custody users only", async () => {
    pg = await legacyDatabase(); await migrate(pg); await pg.transaction(tx => applyKeyEscrow(connection(tx))); await v1();
    const sealed = "v1." + "a".repeat(60);
    await pg.exec(`INSERT INTO wallet_key_escrow(user_id,kind,sealed,provider,origin) VALUES (1,'phrase','${sealed}','local','custody'), (2,'phrase','${sealed}','local','client')`);
    await pg.exec([w(1, "xrpl", "testnet", "rPRE"), w(1, "xrpl", "testnet", "rOLD", "", "Amma XRP"), w(1, "stellar", "testnet", "GA", "", "Amma Stellar"), w(1, "evm", "sepolia", "0xa", "", "Amma Ethereum"), w(1, "xrpl", "mainnet", "rMAIN", "", "Amma XRP"), w(2, "xrpl", "testnet", "rOTHER", "", "Amma XRP")].join(";"));
    await apply();
    const rows = (await pg.query("SELECT user_id, public_key, derivation_index FROM user_wallets ORDER BY id")).rows;
    expect(rows).toEqual([
      { user_id: 1, public_key: "rPRE", derivation_index: null }, { user_id: 1, public_key: "rOLD", derivation_index: 0 },
      { user_id: 1, public_key: "GA", derivation_index: 0 }, { user_id: 1, public_key: "0xa", derivation_index: 0 },
      { user_id: 1, public_key: "rMAIN", derivation_index: null }, { user_id: 2, public_key: "rOTHER", derivation_index: null },
    ]);
  });

  it("aborts without naming an address when a custody user has two onboarding rows for one chain", async () => {
    pg = await legacyDatabase(); await migrate(pg); await pg.transaction(tx => applyKeyEscrow(connection(tx))); await v1();
    await pg.exec(`INSERT INTO wallet_key_escrow(user_id,kind,sealed,provider,origin) VALUES (1,'phrase','v1.${"a".repeat(60)}','local','custody')`);
    await pg.exec([w(1, "xrpl", "testnet", "rSECRETADDR1", "", "Amma XRP"), w(1, "xrpl", "testnet", "rSECRETADDR2", "", "Amma XRP")].join(";"));
    const err = await apply().catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/ambiguous/);
    expect(String((err as Error).message)).not.toContain("rSECRETADDR");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v2'")).rows).toEqual([]);
  });

  it("rolls back a rehearsal, refuses a changed checksum, and detects drift", async () => {
    await base();
    await expect(pg.transaction(async tx => { await applyCustodyV2(connection(tx)); throw new Error("rehearsal"); })).rejects.toThrow("rehearsal");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v2'")).rows).toEqual([]);
    expect((await pg.query("SELECT column_name FROM information_schema.columns WHERE table_name='user_wallets' AND column_name='derivation_index'")).rows).toEqual([]);
    await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='tampered' WHERE version='custody-v2'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
    await pg.exec(`UPDATE amma_chain_migrations SET checksum='${custodyV2Checksum}' WHERE version='custody-v2'`);
    await pg.exec("DROP INDEX idx_user_wallets_derivation");
    await expect(apply()).rejects.toThrow(/drift/);
    await pg.exec("CREATE UNIQUE INDEX idx_user_wallets_derivation ON user_wallets (user_id, chain, network, derivation_index) WHERE derivation_index IS NOT NULL");
    await pg.exec("ALTER TABLE user_wallets DROP CONSTRAINT user_wallets_derivation_index_check");
    await expect(apply()).rejects.toThrow(/drift/);
  });

  it("makes the schema gate require custody-v2 whenever custody-v1 is required", async () => {
    await base();
    await pg.exec("CREATE TABLE billing_events (id serial PRIMARY KEY, tenant_id integer NOT NULL, idempotency_key TEXT); CREATE UNIQUE INDEX uq_billing_credit_idempotency ON billing_events (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL; CREATE TABLE token_registry (jti text PRIMARY KEY, token_type text NOT NULL, nonce text)");
    const facts = () => readSchemaFacts(async (s) => (await pg.query(s)).rows as never);
    for (const env of [{ WELCOME_FUNDING: "true" }, { CUSTODY_SERVER_SIGNING: "true" }]) {
      expect(evaluateSchema(await facts(), env).problems).toEqual(["required migration custody-v2 has not been applied", "required migration custody-v3 has not been applied", "required migration custody-v4 has not been applied", "required migration custody-v5 has not been applied", "missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]);
    }
    expect(evaluateSchema(await facts(), {}).problems).toEqual(["missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]); // required with every flag setting
    await apply();
    expect(evaluateSchema(await facts(), { WELCOME_FUNDING: "true", CUSTODY_SERVER_SIGNING: "true" }).problems).toEqual(["required migration custody-v3 has not been applied", "required migration custody-v4 has not been applied", "required migration custody-v5 has not been applied"]);
  });
});
