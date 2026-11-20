import postgres from "postgres";
import { resolveDatabaseUrl } from "../../lib/docker-secrets";
import { applyChainStorage } from "./chain-storage";
import { chainStorageRunnerAllowed } from "./chain-storage-runner";

class CheckRollback extends Error {}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const expectedDatabase = args.find((arg) => arg.startsWith("--expect-database="))?.slice(18);
  if (!["--check", "--apply"].includes(mode) || !expectedDatabase || args.length !== 2) {
    throw new Error("Usage: migrate-chain-storage.ts --check|--apply --expect-database=NAME");
  }
  // Testnet, or mainnet only when mainnet custody mode is explicitly on (owner-approved mainnet release).
  if (!chainStorageRunnerAllowed(process.env)) throw new Error("Chain storage runner requires STELLAR_NETWORK=testnet, or STELLAR_NETWORK=public with MAINNET_CUSTODY=on");
  const client = postgres(resolveDatabaseUrl(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  let outcome = "";
  try {
    await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout='5s'");
      await tx.unsafe("SET LOCAL statement_timeout='60s'");
      const [identity] = await tx.unsafe<{ name: string }[]>("SELECT current_database() AS name");
      if (identity.name !== expectedDatabase) throw new Error("Database identity does not match --expect-database");
      outcome = await applyChainStorage({
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
  console.log(JSON.stringify({ migration: "chain-storage-v1", mode, outcome, committed: mode === "--apply" }));
}

main().catch(() => {
  // Database errors can contain row values/connection strings; never print them.
  console.error("Chain migration failed; no changes committed. Inspect sanitized schema/preconditions and database identity locally.");
  process.exitCode = 1;
});
