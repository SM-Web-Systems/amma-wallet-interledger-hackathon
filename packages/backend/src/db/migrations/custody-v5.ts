import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { custodyV4Checksum, custodyV4Version } from "./custody-v4";
import type { MigrationConnection } from "./chain-storage";

export const custodyV5Version = "custody-v5";
export const custodyV5Sql = readFileSync(join(__dirname, "custody-v5.sql"), "utf8");
export const custodyV5Checksum = createHash("sha256").update(custodyV5Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Custody schema drift; reconcile before continuing");
  const checks = await connection.rows<{ name: string; def: string }>("SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.user_wallets'::regclass AND contype='c'");
  const squash = (d: string) => d.replace(/\s/g, "");
  const EXPECTED = squash("CHECK ((((chain = 'stellar'::text) AND (network = ANY (ARRAY['public'::text, 'testnet'::text]))) OR ((chain = 'xrpl'::text) AND (network IS NOT NULL) AND (network = ANY (ARRAY['mainnet'::text, 'testnet'::text]))) OR ((chain = 'evm'::text) AND (network = ANY (ARRAY['sepolia'::text, 'ethereum'::text])))))");
  const onNetwork = checks.filter((c) => /(^|[^a-z_])network([^a-z_]|$)/.test(c.def));
  // Exactly one check on the network column, with exactly the reviewed definition.
  if (onNetwork.length !== 1 || onNetwork[0].name !== "user_wallets_chain_network_check" || squash(onNetwork[0].def) !== EXPECTED) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyCustodyV5(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 9)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed custody-v4 migration is required");
  const v4 = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV4Version}'`);
  if (v4[0]?.checksum !== custodyV4Checksum) throw new Error("Reviewed custody-v4 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${custodyV5Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== custodyV5Checksum) throw new Error("Custody-v5 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(custodyV5Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${custodyV5Version}','${custodyV5Checksum}')`);
  return "applied";
}
