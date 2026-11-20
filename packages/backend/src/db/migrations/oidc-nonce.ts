import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MigrationConnection } from "./chain-storage";

export const oidcNonceVersion = "oidc-nonce-v1";
export const oidcNonceSql = readFileSync(join(__dirname, "oidc-nonce-v1.sql"), "utf8");
export const oidcNonceChecksum = createHash("sha256").update(oidcNonceSql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("OIDC nonce schema drift; reconcile before continuing");
  const columns = await connection.rows<{ type: string; nullable: string }>("SELECT data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='token_registry' AND column_name='nonce'");
  if (columns.length !== 1 || columns[0].type !== "text" || columns[0].nullable !== "YES") throw drift();
  const checks = await connection.rows<{ name: string }>("SELECT conname AS name FROM pg_constraint WHERE conrelid='public.token_registry'::regclass AND contype='c' AND conname='token_registry_nonce_shape'");
  if (checks.length !== 1) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. Additive only; no existing column or row changes. */
export async function applyOidcNonce(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 12)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed chain-storage migration is required");
  const table = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.token_registry')::text AS name");
  if (!table[0]?.name) throw new Error("token_registry is missing; the OAuth provider tables are required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${oidcNonceVersion}'`);
  if (entries.length) {
    if (entries[0].checksum !== oidcNonceChecksum) throw new Error("OIDC nonce migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(oidcNonceSql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${oidcNonceVersion}','${oidcNonceChecksum}')`);
  return "applied";
}
