import "dotenv/config"; // the same flags as the API (server.ts loads packages/backend/.env); shell values win
import postgres from "postgres";
import { resolveDatabaseUrl } from "../lib/docker-secrets";
import { evaluateSchema, readSchemaFacts } from "./schema-gate";

// Read-only. Usage: verify-schema.ts --expect-database=NAME
async function main() {
  const args = process.argv.slice(2);
  const expected = args.find((a) => a.startsWith("--expect-database="))?.slice(18);
  if (!expected || args.length !== 1) throw new Error("Usage: verify-schema.ts --expect-database=NAME");
  const sql = postgres(resolveDatabaseUrl(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const result = await sql.begin("READ ONLY", async (tx) => {
      const [{ name }] = await tx.unsafe<{ name: string }[]>("SELECT current_database() AS name");
      if (name !== expected) throw new Error("identity");
      const facts = await readSchemaFacts(async (statement) => Array.from(await tx.unsafe(statement)) as never);
      return evaluateSchema(facts, process.env);
    });
    console.log(JSON.stringify({ check: "schema-gate", ok: result.ok, required: result.required, problems: result.problems }));
    if (!result.ok) process.exitCode = 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  // Never print driver errors: they can contain connection strings.
  console.error(error instanceof Error && error.message === "identity"
    ? "Database identity does not match --expect-database"
    : "Schema gate could not read the database; refusing to deploy.");
  process.exitCode = 1;
});
