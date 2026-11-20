import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { custodyV3Checksum, custodyV3Version } from "./custody-v3";
import type { MigrationConnection } from "./chain-storage";

export const custodyV4Version = "custody-v4";
export const custodyV4Sql = readFileSync(join(__dirname, "custody-v4.sql"), "utf8");
export const custodyV4Checksum = createHash("sha256").update(custodyV4Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Custody schema drift; reconcile before continuing");
  const checks = await connection.rows<{ name: string; def: string }>("SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.wallet_key_escrow'::regclass AND contype='c'");
  const squash = (d: string) => d.replace(/\s/g, "");
  const EXPECTED_ORIGIN = squash("CHECK ((origin = ANY (ARRAY['client'::text, 'custody'::text, 'import'::text])))");
  const EXPECTED_KIND = squash("CHECK (((kind = ANY (ARRAY['phrase'::text, 'stellar-secret'::text])) OR (kind ~ '^import:(stellar|xrpl|evm):[A-Za-z0-9]{20,64}$'::text)))");
  const mentions = (def: string, column: string) => new RegExp(`(^|[^a-z_])${column}([^a-z_]|$)`).test(def);
  const origin = checks.filter((c) => mentions(c.def, "origin"));
  const kind = checks.filter((c) => mentions(c.def, "kind"));
  // Exactly one check on each column, with exactly the reviewed definition.
  if (origin.length !== 1 || origin[0].name !== "wallet_key_escrow_origin_check" || squash(origin[0].def) !== EXPECTED_ORIGIN) throw drift();
  if (kind.length !== 1 || kind[0].name !== "wallet_key_escrow_kind_check" || squash(kind[0].def) !== EXPECTED_KIND) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyCustodyV4(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 8)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed custody-v3 migration is required");
  const v3 = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV3Version}'`);
  if (v3[0]?.checksum !== custodyV3Checksum) throw new Error("Reviewed custody-v3 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV4Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== custodyV4Checksum) throw new Error("Custody-v4 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(custodyV4Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${custodyV4Version}','${custodyV4Checksum}')`);
  return "applied";
}
