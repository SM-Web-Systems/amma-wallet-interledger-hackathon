import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyCustody, custodyChecksum } from "./custody";
import { applyKeyEscrow } from "./key-escrow";
import { evaluateSchema, readSchemaFacts } from "../schema-gate";

let pg: PGlite;
const connection = (tx: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await tx.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows,
});
const escrow = () => pg.transaction(tx => applyKeyEscrow(connection(tx)));
const apply = () => pg.transaction(tx => applyCustody(connection(tx)));
afterEach(async () => { await pg?.close(); });

const wallet = (chain: string, network: string, key: string, secret = "NULL") =>
  `INSERT INTO user_wallets(user_id,chain,name,public_key,encrypted_secret,network) VALUES (1,'${chain}','w','${key}',${secret},'${network}')`;

describe("guarded custody storage", { timeout: 30_000 }, () => {
  it("requires the reviewed chain schema, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await expect(apply()).rejects.toThrow("chain storage migration is required");
    await migrate(pg); await escrow();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v1'")).rows).toHaveLength(1);
  });

  it("adds the durable custody marker column to escrow rows, defaulting to client, and refuses other values", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow(); await apply();
    const sealed = "v1." + "a".repeat(60);
    await pg.exec(`INSERT INTO wallet_key_escrow(user_id,kind,sealed,provider) VALUES (1,'phrase','${sealed}','local')`);
    expect((await pg.query("SELECT origin FROM wallet_key_escrow")).rows[0]).toEqual({ origin: "client" });
    await expect(pg.exec("UPDATE wallet_key_escrow SET origin='other'")).rejects.toThrow();
    await pg.exec("UPDATE wallet_key_escrow SET origin='custody'");
    await pg.exec("ALTER TABLE wallet_key_escrow DROP COLUMN origin");
    await expect(apply()).rejects.toThrow(/drift/);
  });

  it("treats a marked schema without the origin constraint as drift", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow(); await apply();
    await pg.exec("ALTER TABLE wallet_key_escrow DROP CONSTRAINT wallet_key_escrow_origin_check");
    await expect(apply()).rejects.toThrow(/drift/);
  });

  it("needs the key escrow table first", async () => {
    pg = await legacyDatabase(); await migrate(pg);
    await expect(apply()).rejects.toThrow("key escrow migration is required");
  });

  it("rolls back a rehearsal completely", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow();
    await expect(pg.transaction(async tx => { await applyCustody(connection(tx)); throw new Error("rehearsal"); })).rejects.toThrow("rehearsal");
    expect((await pg.query("SELECT to_regclass('welcome_funding') AS name")).rows[0]).toEqual({ name: null });
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v1'")).rows).toEqual([]);
  });

  it("refuses a changed checksum and a marked schema that lost its table", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow(); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='tampered' WHERE version='custody-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
    await pg.exec(`UPDATE amma_chain_migrations SET checksum='${custodyChecksum}' WHERE version='custody-v1'`);
    await pg.exec("DROP TABLE welcome_funding");
    await expect(apply()).rejects.toThrow(/drift/);
  });

  it("adopts a database where the evm no-secret constraint already exists", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow();
    await pg.exec("ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_evm_no_secret CHECK (chain <> 'evm' OR encrypted_secret IS NULL)");
    expect(await apply()).toBe("applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='custody-v1'")).rows).toHaveLength(1);
  });

  it("detects drift when the network check lost evm or the funding uniqueness is gone", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow(); await apply();
    await pg.exec("ALTER TABLE welcome_funding DROP CONSTRAINT welcome_funding_user_id_chain_key");
    await expect(apply()).rejects.toThrow(/drift/);
    await pg.exec("ALTER TABLE welcome_funding ADD UNIQUE (user_id, chain)");
    expect(await apply()).toBe("already-applied");
    await pg.exec("ALTER TABLE user_wallets DROP CONSTRAINT user_wallets_chain_network_check");
    await pg.exec("ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_chain_network_check CHECK ((chain = 'stellar' AND network IN ('public','testnet')) OR (chain = 'xrpl' AND network IN ('mainnet','testnet')))");
    await expect(apply()).rejects.toThrow(/drift/);
  });

  it("accepts Sepolia EVM wallets without a secret, and still the Stellar public network", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow();
    await expect(pg.exec(wallet("evm", "sepolia", "0xabc"))).rejects.toThrow();
    await apply();
    await pg.exec(wallet("evm", "sepolia", "0xabc"));
    await pg.exec(wallet("stellar", "public", "GABC", "'sealed'"));
    await expect(pg.exec(wallet("evm", "mainnet", "0xdef"))).rejects.toThrow();
    await expect(pg.exec(wallet("evm", "sepolia", "0xdef", "'sealed'"))).rejects.toThrow();
  });

  it("keeps one welcome funding row per user and chain, only known chains and states", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow(); await apply();
    const row = (chain: string, state: string, user = 1) => `INSERT INTO welcome_funding(user_id,chain,address,state) VALUES (${user},'${chain}','addr','${state}')`;
    await pg.exec(row("evm", "queued"));
    await expect(pg.exec(row("evm", "sent"))).rejects.toThrow();
    await pg.exec(row("stellar", "queued"));
    await expect(pg.exec(row("btc", "queued", 2))).rejects.toThrow();
    await expect(pg.exec(row("evm", "bogus", 2))).rejects.toThrow();
    await pg.exec("DELETE FROM users WHERE id=1");
    expect((await pg.query("SELECT count(*)::int AS n FROM welcome_funding")).rows[0]).toEqual({ n: 0 });
  });

  it("makes the schema gate require the marker when custody flags are on", async () => {
    pg = await legacyDatabase(); await migrate(pg); await escrow();
    await pg.exec("CREATE TABLE billing_events (id serial PRIMARY KEY, tenant_id integer NOT NULL, idempotency_key TEXT); CREATE UNIQUE INDEX uq_billing_credit_idempotency ON billing_events (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL; CREATE TABLE token_registry (jti text PRIMARY KEY, token_type text NOT NULL, nonce text)");
    const facts = () => readSchemaFacts(async (s) => (await pg.query(s)).rows as never);
    for (const env of [{ WELCOME_FUNDING: "true" }, { CUSTODY_SERVER_SIGNING: "true" }]) {
      expect(evaluateSchema(await facts(), env).problems).toEqual(["required migration custody-v1 has not been applied", "required migration custody-v2 has not been applied", "required migration custody-v3 has not been applied", "required migration custody-v4 has not been applied", "required migration custody-v5 has not been applied", "missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]);
    }
    expect(evaluateSchema(await facts(), {}).problems).toEqual(["missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]); // required with every flag setting
    expect(evaluateSchema(await facts(), { WELCOME_FUNDING: "1" }).problems).toEqual(["required migration custody-v1 has not been applied", "required migration custody-v2 has not been applied", "required migration custody-v3 has not been applied", "required migration custody-v4 has not been applied", "required migration custody-v5 has not been applied", "missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]);
    await apply();
    expect(evaluateSchema(await facts(), { WELCOME_FUNDING: "true", CUSTODY_SERVER_SIGNING: "true" }).problems).toEqual(["required migration custody-v2 has not been applied", "required migration custody-v3 has not been applied", "required migration custody-v4 has not been applied", "required migration custody-v5 has not been applied", "missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]);
  });
});
