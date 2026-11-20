import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activationV1Checksum, activationV1Version } from "./activation-v1";
import type { MigrationConnection } from "./chain-storage";

export const activationRequirementsV1Version = "activation-requirements-v1";
export const activationRequirementsV1Sql = readFileSync(join(__dirname, "activation-requirements-v1.sql"), "utf8");
export const activationRequirementsV1Checksum = createHash("sha256").update(activationRequirementsV1Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Activation requirements schema drift; reconcile before continuing");
  const have = new Set((await connection.rows<{ name: string }>(
    "SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='partner_tasks'")).map((c) => c.name));
  for (const n of ["requirement_kind", "requirement_contract", "requirement_network"]) if (!have.has(n)) throw drift();
  const check = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.partner_tasks'::regclass AND conname='partner_tasks_requirement'");
  if (check.length !== 1 || !check[0].def.includes("holds_nft")) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyActivationRequirementsV1(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 18)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed activation-v1 migration is required");
  const activation = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${activationV1Version}'`);
  if (activation[0]?.checksum !== activationV1Checksum) throw new Error("Reviewed activation-v1 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${activationRequirementsV1Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== activationRequirementsV1Checksum) throw new Error("Activation-requirements-v1 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(activationRequirementsV1Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${activationRequirementsV1Version}','${activationRequirementsV1Checksum}')`);
  return "applied";
}
