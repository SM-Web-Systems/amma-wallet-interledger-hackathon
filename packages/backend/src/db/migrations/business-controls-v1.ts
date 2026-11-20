import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { creditsV1Checksum, creditsV1Version } from "./credits-v1";
import type { MigrationConnection } from "./chain-storage";

export const businessControlsV1Version = "business-controls-v1";
export const businessControlsV1Sql = readFileSync(join(__dirname, "business-controls-v1.sql"), "utf8");
export const businessControlsV1Checksum = createHash("sha256").update(businessControlsV1Sql.replace(/\r\n/g, "\n")).digest("hex");

async function verifySchema(connection: MigrationConnection) {
  const drift = () => new Error("Business controls schema drift; reconcile before continuing");
  const cols = async (table: string) => new Set((await connection.rows<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}'`)).map((c) => c.name));
  const controls = await cols("business_activation_controls");
  for (const n of ["tenant_id", "paused_at", "paused_by", "floor_xlm", "below_floor_since", "floor_hold_since"]) if (!controls.has(n)) throw drift();
  const alerts = await cols("business_alerts");
  for (const n of ["tenant_id", "kind", "detail", "sent_to", "delivered"]) if (!alerts.has(n)) throw drift();
  const hold = await connection.rows<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.business_activation_controls'::regclass AND conname='business_controls_hold'");
  if (hold.length !== 1) throw drift();
}

/** Caller owns the transaction: failure rolls back DDL and marker together. */
export async function applyBusinessControlsV1(connection: MigrationConnection): Promise<"applied" | "already-applied"> {
  await connection.execute("SELECT pg_advisory_xact_lock(731241, 19)");
  const marker = await connection.rows<{ name: string | null }>("SELECT to_regclass('public.amma_chain_migrations')::text AS name");
  if (!marker[0]?.name) throw new Error("Reviewed credits-v1 migration is required");
  const credits = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${creditsV1Version}'`);
  if (credits[0]?.checksum !== creditsV1Checksum) throw new Error("Reviewed credits-v1 migration is required");
  const entries = await connection.rows<{ checksum: string }>(`SELECT checksum FROM amma_chain_migrations WHERE version='${businessControlsV1Version}'`);
  if (entries.length) {
    if (entries[0].checksum !== businessControlsV1Checksum) throw new Error("Business-controls-v1 migration checksum mismatch");
    await verifySchema(connection);
    return "already-applied";
  }
  await connection.execute(businessControlsV1Sql);
  await verifySchema(connection);
  await connection.execute(`INSERT INTO amma_chain_migrations(version,checksum) VALUES ('${businessControlsV1Version}','${businessControlsV1Checksum}')`);
  return "applied";
}
