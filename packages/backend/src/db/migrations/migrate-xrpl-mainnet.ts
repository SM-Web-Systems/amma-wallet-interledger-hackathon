import postgres from "postgres";
import { resolveDatabaseUrl } from "../../lib/docker-secrets";
import { applyXrplMainnet } from "./xrpl-mainnet";
import { xrplMainnetRunnerAllowed } from "./xrpl-runner";

class CheckRollback extends Error {}
async function main() {
  const args = process.argv.slice(2), mode = args[0];
  const expectedDatabase = args.find((arg) => arg.startsWith("--expect-database="))?.slice(18);
  if (!["--check", "--apply"].includes(mode) || !expectedDatabase || args.length !== 2) throw new Error("Usage: migrate-xrpl-mainnet.ts --check|--apply --expect-database=NAME");
  if (!xrplMainnetRunnerAllowed(process.env)) throw new Error("XRP mainnet runner needs XRPL_MAINNET_CUSTODY=on with MAINNET_CUSTODY=on, STELLAR_NETWORK=public and XRPL_NETWORK=mainnet");
  const client = postgres(resolveDatabaseUrl(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  let outcome = "";
  try {
    await client.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout='5s'"); await tx.unsafe("SET LOCAL statement_timeout='60s'");
      const [identity] = await tx.unsafe<{ name: string }[]>("SELECT current_database() AS name");
      if (identity.name !== expectedDatabase) throw new Error("Database identity mismatch");
      outcome = await applyXrplMainnet({ execute: async (statement) => { await tx.unsafe(statement); }, rows: async <T extends Record<string, unknown>>(statement: string) => Array.from(await tx.unsafe<T[]>(statement)) });
      if (mode === "--check") throw new CheckRollback();
    });
  } catch (cause) { if (!(cause instanceof CheckRollback)) throw cause; }
  finally { await client.end({ timeout: 5 }); }
  // CLI output on stdout (G-11: no console calls). Database errors are never printed: they can contain row values.
  process.stdout.write(`${JSON.stringify({ migration: "xrpl-mainnet-v1", mode, outcome, committed: mode === "--apply" })}\n`);
}
main().catch(() => { process.stderr.write("XRP mainnet migration did not complete cleanly. Recheck its marker, checksum and database identity before retrying.\n"); process.exitCode = 1; });
