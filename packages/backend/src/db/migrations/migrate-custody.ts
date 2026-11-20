import postgres from "postgres";
import { resolveDatabaseUrl } from "../../lib/docker-secrets";
import { applyCustody } from "./custody";
import { appLog } from "../../lib/app-log";

class CheckRollback extends Error {}

// Same contract as the guarded runners: an explicit database identity, one
// transaction, and --check as a full rehearsal that always rolls back.
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const expectedDatabase = args.find((arg) => arg.startsWith("--expect-database="))?.slice(18);
  if (!["--check", "--apply"].includes(mode) || !expectedDatabase || args.length !== 2) {
    throw new Error("Usage: migrate-custody.ts --check|--apply --expect-database=NAME");
  }
  const client = postgres(resolveDatabaseUrl(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  let outcome = "";
  try {
    await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout='5s'");
      await tx.unsafe("SET LOCAL statement_timeout='60s'");
      const [identity] = await tx.unsafe<{ name: string }[]>("SELECT current_database() AS name");
      if (identity.name !== expectedDatabase) throw new Error("Database identity does not match --expect-database");
      outcome = await applyCustody({
        execute: async (statement) => { await tx.unsafe(statement); },
        rows: async <T extends Record<string, unknown>>(statement: string) => Array.from(await tx.unsafe<T[]>(statement)),
      });
      if (mode === "--check") throw new CheckRollback();
    });
  } catch (error) {
    if (!(error instanceof CheckRollback)) throw error;
  } finally {
    await client.end({ timeout: 5 });
  }
  appLog().info({ migration: "custody-v1", mode, outcome, committed: mode === "--apply" }, "custody migration finished");
}

main().catch(() => {
  appLog().error({ migration: "custody-v1" }, "Custody migration failed; no changes committed. Inspect sanitized preconditions and database identity locally.");
  process.exitCode = 1;
});
