import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "./chain-storage.test-support";
import { applyKeyEscrow } from "./key-escrow";
import { applyCustody } from "./custody";
import { applyCustodyV2 } from "./custody-v2";
import { applyCustodyV3 } from "./custody-v3";
import { applyCustodyV4 } from "./custody-v4";
import { applyCustodyV5 } from "./custody-v5";
import { applyActivationV1 } from "./activation-v1";

export const connectionOf = (pg: { exec(sql: string): Promise<unknown>; query<T>(sql: string): Promise<{ rows: T[] }> }) => ({
  execute: async (sql: string) => { await pg.exec(sql); },
  rows: async <T extends Record<string, unknown>>(sql: string) => (await pg.query<T>(sql)).rows,
});

/** The billing tables the activation code reads and writes, copied verbatim from the committed drizzle migration. */
export async function addBillingTables(pg: PGlite) {
  const ddl = readFileSync(resolve("drizzle", "0003_petite_emma_frost.sql"), "utf8");
  for (const name of ["billing_events", "tenant_billing_policy", "bundle_catalog", "tenant_bundle_purchases", "tenant_alert_log"]) {
    const start = ddl.indexOf(`CREATE TABLE "${name}" (`);
    if (start < 0) throw new Error(`Missing DDL for ${name}`);
    await pg.exec(ddl.slice(start, ddl.indexOf("\n);", start) + 3));
  }
  await pg.exec(`ALTER TABLE billing_events ADD COLUMN idempotency_key text;
    CREATE UNIQUE INDEX uq_billing_credit_idempotency ON billing_events (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    ALTER TABLE tenant_api_keys ALTER COLUMN scopes SET DEFAULT '{}';`);
}

/** Everything up to and including custody-v5 plus the billing tables, ready for activation-v1. */
export async function databaseUpToCustodyV5(): Promise<PGlite> {
  const pg = await legacyDatabase();
  await migrate(pg);
  await addBillingTables(pg);
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2, applyCustodyV3, applyCustodyV4, applyCustodyV5]) await pg.transaction((tx) => apply(connectionOf(tx)));
  return pg;
}

/** The same, with activation-v1 applied and the audit table the routes write to. */
export async function activationDatabase(): Promise<PGlite> {
  const pg = await databaseUpToCustodyV5();
  await pg.transaction((tx) => applyActivationV1(connectionOf(tx)));
  await pg.exec(`CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY, user_id integer, action varchar(50) NOT NULL, detail jsonb DEFAULT '{}',
    ip_address varchar(45), user_agent text, created_at timestamp DEFAULT now())`);
  return pg;
}
