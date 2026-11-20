import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyActivationV1 } from "./activation-v1";
import { connectionOf, databaseUpToCustodyV5 } from "./activation.test-support";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyKeyEscrow } from "./key-escrow";
import { applyCustody } from "./custody";
import { applyCustodyV2 } from "./custody-v2";
import { applyCustodyV3 } from "./custody-v3";
import { applyCustodyV4 } from "./custody-v4";
import { evaluateSchema, readSchemaFacts, requiredMarkers } from "../schema-gate";

let pg: PGlite;
const apply = () => pg.transaction((tx) => applyActivationV1(connectionOf(tx)));
afterEach(async () => { await pg?.close(); });
const facts = async () => readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);

describe("guarded activation-v1 storage", { timeout: 60_000 }, () => {
  it("requires custody-v5, applies once and records its checksum", async () => {
    pg = await legacyDatabase(); await migrate(pg);
    for (const a of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4]) await pg.transaction((tx) => a(connectionOf(tx)));
    await expect(apply()).rejects.toThrow("custody-v5 migration is required");
  });

  it("applies once and a rerun reports already-applied", async () => {
    pg = await databaseUpToCustodyV5();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='activation-v1'")).rows).toHaveLength(1);
  });

  it("refuses a changed checksum", async () => {
    pg = await databaseUpToCustodyV5(); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='activation-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
  });

  it("refuses drift: a missing table, a loosened state check, a dropped unique index", async () => {
    pg = await databaseUpToCustodyV5(); await apply();
    await pg.exec("ALTER TABLE wallet_activations DROP CONSTRAINT wallet_activations_state_check; ALTER TABLE wallet_activations ADD CONSTRAINT wallet_activations_state_check CHECK (state <> '')");
    await expect(apply()).rejects.toThrow("schema drift");
    await pg.close();
    pg = await databaseUpToCustodyV5(); await apply();
    await pg.exec("DROP INDEX wallet_activations_once_per_address");
    await expect(apply()).rejects.toThrow("schema drift");
    await pg.close();
    pg = await databaseUpToCustodyV5(); await apply();
    await pg.exec("DROP TABLE activation_reconciliations");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("allows one live activation per address but lets a skipped or refunded record coexist", async () => {
    pg = await databaseUpToCustodyV5(); await apply();
    await pg.exec(`INSERT INTO tenants (id, slug, name) VALUES (1,'t','T');
      INSERT INTO tenant_api_keys (tenant_id, name, key_hash, key_prefix) VALUES (1,'k','h','p');
      INSERT INTO partner_signing_keys (tenant_id, key_id, public_key) VALUES (1,'key-1','${"A".repeat(43)}=');
      INSERT INTO partner_tasks (tenant_id, task_key, name, chains, created_by) SELECT 1, 'course:' || g, 'A', '{stellar}', 'test' FROM generate_series(1,3) g;
      INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'stellar','testnet','GADDR','w',true,0);
      INSERT INTO partner_task_completions (tenant_id, task_id, user_id, api_key_id, signing_key_id, partner_completion_id, idempotency_key, request_digest, completed_at)
        SELECT 1, g, 1, 1, 1, 'completion-' || g, 'idem-key-' || g, repeat('a',64), now() FROM generate_series(1,3) g`);
    const row = (completion: number, state: string) => pg.query(
      "INSERT INTO wallet_activations (completion_id, tenant_id, user_id, wallet_id, chain, network, address, payer, grant_base_units, state) VALUES ($1,1,1,1,'stellar','testnet','GADDR','tenant',11000000,$2)", [completion, state]);
    await row(1, "reserved");
    await expect(row(2, "reserved")).rejects.toThrow();
    await row(2, "skipped_already_active");
    await pg.exec("UPDATE wallet_activations SET state='refunded' WHERE completion_id=1");
    await row(3, "reserved");
    await expect(pg.query("UPDATE wallet_activations SET attempts=4 WHERE completion_id=3")).rejects.toThrow();
    await expect(pg.query("UPDATE wallet_activations SET state='bogus' WHERE completion_id=3")).rejects.toThrow();
  });

  it("a task Amma pays for must carry both caps, and every attempt's hash is kept in an array column", async () => {
    pg = await databaseUpToCustodyV5(); await apply();
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (1,'t','T')");
    const task = (cols: string) => pg.query(`INSERT INTO partner_tasks (tenant_id, task_key, name, chains, payer, ${cols.split("=")[0]}, created_by) VALUES (1, 'course:' || random()::text, 'A', '{stellar}', 'amma', ${cols.split("=")[1]}, 'test')`);
    await expect(pg.query("INSERT INTO partner_tasks (tenant_id, task_key, name, chains, payer, created_by) VALUES (1,'course:a','A','{stellar}','amma','t')")).rejects.toThrow();
    await expect(task("daily_cap=5")).rejects.toThrow();
    await pg.query("INSERT INTO partner_tasks (tenant_id, task_key, name, chains, payer, daily_cap, total_cap, created_by) VALUES (1,'course:b','A','{stellar}','amma',5,50,'t')");
    await pg.query("INSERT INTO partner_tasks (tenant_id, task_key, name, chains, payer, created_by) VALUES (1,'course:c','A','{stellar}','tenant','t')");
    expect((await pg.query<{ d: string }>("SELECT column_default AS d FROM information_schema.columns WHERE table_name='wallet_activations' AND column_name='tx_hashes'")).rows[0].d).toContain("{}");
    await pg.exec("ALTER TABLE partner_tasks DROP CONSTRAINT partner_tasks_amma_needs_caps");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("is required by the gate when TASK_ACTIVATION is on, and only then", async () => {
    pg = await databaseUpToCustodyV5();
    for (const value of ["on", "true", "1"]) {
      const env = { TASK_ACTIVATION: value };
      expect(requiredMarkers(env)).toContain("activation-v1");
      expect(evaluateSchema(await facts(), env).problems).toContain("required migration activation-v1 has not been applied");
    }
    expect(requiredMarkers({})).not.toContain("activation-v1");
    expect(requiredMarkers({ TASK_ACTIVATION: "off" })).not.toContain("activation-v1");
    await apply();
    expect(evaluateSchema(await facts(), { TASK_ACTIVATION: "on" }).problems.filter((p) => p.includes("activation-v1"))).toEqual([]);
    // The marker is known to the gate even when the flag is off (an older build must not treat it as foreign).
    expect(evaluateSchema(await facts(), {}).problems.filter((p) => p.includes("unrecognized"))).toEqual([]);
  });
});
