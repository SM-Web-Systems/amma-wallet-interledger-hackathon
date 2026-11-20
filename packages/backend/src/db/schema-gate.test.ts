import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate, migrateWithCustodyV2 } from "./migrations/chain-storage.test-support";
import { chainStorageChecksum } from "./migrations/chain-storage";
import { evaluateSchema, readSchemaFacts, requiredMarkers, startupSchemaGate } from "./schema-gate";
import { applyKeyEscrow } from "./migrations/key-escrow";
import { applyCustody } from "./migrations/custody";
import { applyCustodyV2 } from "./migrations/custody-v2";
import { applyCustodyV3 } from "./migrations/custody-v3";
import { applyCustodyV4 } from "./migrations/custody-v4";
import { applyCustodyV5 } from "./migrations/custody-v5";
import { xrplMainnetChecksum, xrplMainnetVersion } from "./migrations/xrpl-mainnet";

describe("XRP on mainnet gate requirements", () => {
  const ON = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet", XRPL_MAINNET_CUSTODY: "on", CUSTODY_SERVER_SIGNING: "true" };
  it("requires every XRP migration the custody send path uses, plus xrpl-mainnet-v1, when the switch is on", () => {
    expect(requiredMarkers(ON)).toEqual(["chain-storage-v1", "custody-v1", "custody-v2", "custody-v3", "custody-v4", "custody-v5",
      "xrpl-payments-v1", "xrpl-reconciliation-v1", "xrpl-integration-v1", "xrpl-mainnet-v1"]);
    // No duplicates when the XRP flags are on as well.
    expect(requiredMarkers({ ...ON, XRPL_PAYMENTS_ENABLED: "true", XRPL_RECONCILIATION_ENABLED: "true" }).filter((m) => m.startsWith("xrpl-")))
      .toEqual(["xrpl-payments-v1", "xrpl-reconciliation-v1", "xrpl-integration-v1", "xrpl-mainnet-v1"]);
  });
  it("adds nothing when the switch is off (today's requirements)", () => {
    const { XRPL_MAINNET_CUSTODY: _s, XRPL_NETWORK: _n, ...off } = ON;
    expect(requiredMarkers(off)).toEqual(["chain-storage-v1", "custody-v1", "custody-v2", "custody-v3", "custody-v4", "custody-v5"]);
    expect(requiredMarkers({ ...off, XRPL_MAINNET_CUSTODY: "off" })).not.toContain("xrpl-mainnet-v1");
  });
  it("recognises the xrpl-mainnet-v1 marker", () => {
    const facts = { markerTable: true, markers: [{ version: xrplMainnetVersion, checksum: xrplMainnetChecksum }], columns: [], validIndexes: [] };
    expect(evaluateSchema(facts, {}).problems.some((p) => p.includes("xrpl-mainnet-v1"))).toBe(false);
    expect(evaluateSchema({ ...facts, markers: [{ version: xrplMainnetVersion, checksum: "x" }] }, {}).problems).toContain("checksum mismatch for xrpl-mainnet-v1");
  });
});

// PR #1's billing migration, as an operator applies it (step 2 runs outside a transaction).
async function billing(d: PGlite, index = true) {
  await d.exec("CREATE TABLE billing_events (id serial PRIMARY KEY, tenant_id integer NOT NULL)");
  await d.exec("ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS idempotency_key TEXT");
  // oidc-nonce-v1, as the guarded runner leaves it (the gate reads only catalog metadata).
  await d.exec("CREATE TABLE token_registry (jti text PRIMARY KEY, token_type text NOT NULL, nonce text)");
  if (index) await d.exec("CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_credit_idempotency ON billing_events (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
}

let db: PGlite | undefined;
afterEach(async () => { await db?.close(); db = undefined; });
const facts = (d: PGlite) => readSchemaFacts(async (statement) => (await d.query(statement)).rows as never);

describe("deploy schema gate", { timeout: 30_000 }, () => {
  it("refuses to deploy this build onto the pre-chain-storage schema", async () => {
    db = await legacyDatabase();
    const result = evaluateSchema(await facts(db), {});
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.stringContaining("amma_chain_migrations is missing"),
      "required migration chain-storage-v1 has not been applied",
      "missing column user_wallets.chain",
    ]));
  });

  it("passes once the guarded chain-storage migration has been applied, with all flags off", async () => {
    db = await legacyDatabase();
    await migrateWithCustodyV2(db);
    await billing(db);
    expect(evaluateSchema(await facts(db), {})).toMatchObject({ ok: true, problems: [], required: ["chain-storage-v1"] });
  });

  it("requires the payment migrations only for the features that are switched on", async () => {
    db = await legacyDatabase();
    await migrateWithCustodyV2(db);
    await billing(db);
    const result = evaluateSchema(await facts(db), { XRPL_PAYMENTS_ENABLED: "true", PAYMENTS_ENABLED: "true" });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["required migration xrpl-payments-v1 has not been applied", "required migration interledger-payments-v1 has not been applied"]);
  });

  it("refuses when the billing idempotency column or its unique index is missing", async () => {
    db = await legacyDatabase();
    await migrateWithCustodyV2(db);
    expect(evaluateSchema(await facts(db), {}).problems).toEqual(["missing column billing_events.idempotency_key", "missing column token_registry.nonce", "missing or invalid index uq_billing_credit_idempotency"]);
    await billing(db, false);
    expect(evaluateSchema(await facts(db), {}).problems).toEqual(["missing or invalid index uq_billing_credit_idempotency"]);
  });

  it("refuses when the OIDC nonce column is missing", async () => {
    db = await legacyDatabase();
    await migrateWithCustodyV2(db);
    await billing(db);
    await db.exec("ALTER TABLE token_registry DROP COLUMN nonce");
    expect(evaluateSchema(await facts(db), {}).problems).toEqual(["missing column token_registry.nonce"]);
  });

  it("rejects a tampered checksum and a marker from a newer build", () => {
    const columns = ["user_wallets.chain", "tx_history.chain", "tx_history.network", "address_book.chain", "address_book.network", "billing_events.idempotency_key", "token_registry.nonce", "user_wallets.derivation_index"];
    const validIndexes = ["uq_billing_credit_idempotency", "idx_user_wallets_derivation"];
    expect(evaluateSchema({ markerTable: true, columns, validIndexes, markers: [{ version: "chain-storage-v1", checksum: "tampered" }] }, {}).problems)
      .toEqual(["checksum mismatch for chain-storage-v1"]);
    expect(evaluateSchema({ markerTable: true, columns, validIndexes, markers: [{ version: "chain-storage-v1", checksum: chainStorageChecksum }, { version: "evm-v1", checksum: "x" }] }, {}).problems)
      .toEqual(["unrecognized migration marker evm-v1: this build is older than the database"]);
  });

  it("treats only the exact string true as enabled", () => {
    expect(requiredMarkers({ XRPL_INTEGRATION_ENABLED: "TRUE", PAYMENTS_ENABLED: "1" })).toEqual(["chain-storage-v1"]);
    expect(requiredMarkers({ XRPL_INTEGRATION_ENABLED: "true" })).toEqual(["chain-storage-v1", "xrpl-payments-v1", "xrpl-reconciliation-v1", "xrpl-integration-v1"]);
  });

  it("requires the key escrow and recovery tables only when a master key provider is configured", () => {
    expect(requiredMarkers({})).toEqual(["chain-storage-v1"]);
    expect(requiredMarkers({ KEY_WRAP_PROVIDER: "local" })).toEqual(["chain-storage-v1", "key-escrow-v1", "key-recovery-v1"]);
  });
});

describe("custody gate requirements", () => {
  it("requires custody-v1, v2 and v3 only when a custody flag is on", () => {
    expect(requiredMarkers({})).toEqual(["chain-storage-v1"]);
    expect(requiredMarkers({ CUSTODY_SERVER_SIGNING: "true" })).toEqual(["chain-storage-v1", "custody-v1", "custody-v2", "custody-v3", "custody-v4", "custody-v5"]);
    expect(requiredMarkers({ WELCOME_FUNDING: "true" })).toEqual(["chain-storage-v1", "custody-v1", "custody-v2", "custody-v3", "custody-v4", "custody-v5"]);
    expect(requiredMarkers({ WELCOME_FUNDING: "false" })).toEqual(["chain-storage-v1"]);
  });

  const custodyOn = { CUSTODY_SERVER_SIGNING: "true" };
  const applyCustodyMigrations = async (d: PGlite) => {
    for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4, applyCustodyV5]) {
      await d.transaction((tx) => apply({ execute: async (s: string) => { await tx.exec(s); }, rows: async (s: string) => (await tx.query(s)).rows as any }));
    }
  };
  const rowsOf = (d: PGlite) => async (s: string) => (await d.query(s)).rows as never;

  it("requires user_wallets.derivation_index and its index with every flag setting, custody on or off", async () => {
    db = await legacyDatabase();
    await migrate(db);
    await billing(db);
    const on = evaluateSchema(await facts(db), custodyOn);
    expect(on.problems).toEqual(expect.arrayContaining(["missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]));
    expect(evaluateSchema(await facts(db), {}).problems).toEqual(expect.arrayContaining(["missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]));
    expect(evaluateSchema(await facts(db), { ETH_ALERTS: "on" }).problems).toEqual(expect.arrayContaining(["missing column user_wallets.derivation_index"]));
  });

  it("fails when the column was dropped after custody-v2 was applied (marker present)", async () => {
    db = await legacyDatabase();
    await migrate(db);
    await billing(db);
    await applyCustodyMigrations(db);
    expect(evaluateSchema(await facts(db), custodyOn)).toMatchObject({ ok: true, problems: [] });
    // What `drizzle-kit push` did to a schema that did not declare the column.
    await db.exec("ALTER TABLE user_wallets DROP COLUMN derivation_index");
    const after = evaluateSchema(await facts(db), custodyOn);
    expect(after.ok).toBe(false);
    expect(after.problems).toEqual(["missing column user_wallets.derivation_index", "missing or invalid index idx_user_wallets_derivation"]);
  });

  it("startupSchemaGate reports a read failure as a problem without the driver's message", async () => {
    const result = await startupSchemaGate(async () => { throw new Error("connect ECONNREFUSED postgres://u:secret@db/x"); }, {});
    expect(result).toMatchObject({ ok: false, problems: ["the schema gate could not read the database"], required: ["chain-storage-v1"], unreadable: true });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("startupSchemaGate gives up on a hung read after its timeout", async () => {
    const result = await startupSchemaGate(() => new Promise(() => {}), {}, 50);
    expect(result).toMatchObject({ ok: false, unreadable: true });
  });

  it("startupSchemaGate is skipped only with SCHEMA_GATE_AT_START=off and NODE_ENV development or test", async () => {
    const failing = async () => { throw new Error("down"); };
    expect(await startupSchemaGate(failing, { SCHEMA_GATE_AT_START: "off", NODE_ENV: "development" })).toEqual({ ok: true, problems: [], required: [], skipped: true });
    expect(await startupSchemaGate(failing, { SCHEMA_GATE_AT_START: "off", NODE_ENV: "test" })).toMatchObject({ skipped: true });
    for (const NODE_ENV of ["production", undefined, "staging"]) expect((await startupSchemaGate(failing, { SCHEMA_GATE_AT_START: "off", NODE_ENV })).ok).toBe(false);
    db = await legacyDatabase();
    await migrateWithCustodyV2(db);
    await billing(db);
    expect(await startupSchemaGate(rowsOf(db), {})).toMatchObject({ ok: true, problems: [] });
  });

  it("startupSchemaGate passes when the database has a marker newer than this build, with a warning; the deploy gate stays strict", async () => {
    db = await legacyDatabase();
    await migrateWithCustodyV2(db);
    await billing(db);
    await db.exec("INSERT INTO amma_chain_migrations (version, checksum) VALUES ('future-v9', 'x')");
    expect(evaluateSchema(await facts(db), {}).problems).toEqual([expect.stringContaining("unrecognized migration marker future-v9")]);
    expect(await startupSchemaGate(rowsOf(db), {})).toMatchObject({ ok: true, problems: [], warnings: [expect.stringContaining("future-v9")] });
    await db.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='chain-storage-v1'");
    expect((await startupSchemaGate(rowsOf(db), {})).problems).toEqual(["checksum mismatch for chain-storage-v1"]);
  });
});
