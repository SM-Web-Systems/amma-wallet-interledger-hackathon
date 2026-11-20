import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyChainStorage, type MigrationConnection } from "./chain-storage";
import { applyKeyEscrow } from "./key-escrow";
import { applyCustody } from "./custody";
import { applyCustodyV2 } from "./custody-v2";

/** Relevant baseline DDL extracted verbatim from the committed migrations. */
export async function legacyDatabase(dataDir?: string) {
  const db = new PGlite(dataDir);
  const history = ["0000_dry_micromacro.sql", "0002_concerned_thunderbolts.sql"]
    .map((name) => readFileSync(resolve("drizzle", name), "utf8")).join("\n");
  for (const name of ["users", "user_wallets", "tx_history", "address_book", "portfolio_snapshots"]) {
    const statement = history.match(new RegExp(`CREATE TABLE "${name}" \\([\\s\\S]*?\\n\\);`));
    if (!statement) throw new Error(`Missing baseline DDL for ${name}`);
    await db.exec(statement[0]);
  }
  const tenantDdl = readFileSync(resolve("drizzle", "0003_petite_emma_frost.sql"), "utf8");
  for (const name of ["tenants", "tenant_api_keys", "tenant_users"]) {
    const start = tenantDdl.indexOf(`CREATE TABLE "${name}" (`);
    if (start < 0) throw new Error(`Missing tenant DDL for ${name}`);
    await db.exec(tenantDdl.slice(start, tenantDdl.indexOf("\n);", start) + 3));
  }
  await db.exec(`CREATE UNIQUE INDEX idx_user_wallets_user_pubkey ON user_wallets(user_id, public_key);
    ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_user_id_users_id_fk FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;
    INSERT INTO users(id,email,password_hash) VALUES (1,'one@example.invalid','unused'), (2,'two@example.invalid','unused');`);
  return db;
}

export async function migrate(db: PGlite) {
  return db.transaction(async (tx) => applyChainStorage({
    execute: async (statement) => { await tx.exec(statement); },
    rows: async <T extends Record<string, unknown>>(statement: string) => (await tx.query<T>(statement)).rows,
  } satisfies MigrationConnection));
}

/** `migrate`, then key-escrow, custody-v1 and custody-v2, each in its own transaction: gives a test database the `user_wallets.derivation_index` column that the Drizzle schema declares and every wallet query reads. */
export async function migrateWithCustodyV2(db: PGlite) {
  await migrate(db);
  for (const apply of [applyKeyEscrow, applyCustody, applyCustodyV2]) {
    await db.transaction(async (tx) => apply({
      execute: async (statement: string) => { await tx.exec(statement); },
      rows: async <T extends Record<string, unknown>>(statement: string) => (await tx.query<T>(statement)).rows,
    }));
  }
}
