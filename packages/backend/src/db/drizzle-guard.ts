import { readFileSync } from "node:fs";
import { join } from "node:path";
// drizzle-kit push / migrate change the database outside the reviewed guarded migrations, and push drops what the
// Drizzle schema does not declare (without a TTY, without asking). Only a disposable test database may use them.
export const BLOCKED_DRIZZLE_COMMANDS: readonly string[] = ["push", "migrate", "up", "drop"];

/** Why drizzle-kit must not run this command, or null when it may. Reads only argv and ALLOW_DRIZZLE_PUSH; never prints DATABASE_URL. */
export function drizzleCommandRefusal(argv: readonly string[], env: Record<string, string | undefined>): string | null {
  const command = argv.slice(2).find((a) => BLOCKED_DRIZZLE_COMMANDS.includes(a));
  if (!command || env.ALLOW_DRIZZLE_PUSH === "1") return null;
  return `drizzle-kit ${command} is blocked: it can drop tables, columns and indexes that the reviewed migrations own. ` +
    "Apply schema changes with the guarded db:migrate-* scripts. Set ALLOW_DRIZZLE_PUSH=1 only for a disposable test database.";
}

/**
 * ALLOW_DRIZZLE_PUSH as the caller's shell set it. drizzle-kit loads packages/backend/.env itself before it reads the config,
 * so process.env cannot tell a shell value from a .env line: when .env defines the variable, it is not honoured.
 */
export function allowFromShell(env: Record<string, string | undefined>, dotenvText: string): { ALLOW_DRIZZLE_PUSH: string | undefined } {
  const inDotenv = /^\s*(?:export\s+)?ALLOW_DRIZZLE_PUSH\s*=/m.test(dotenvText);
  return { ALLOW_DRIZZLE_PUSH: inDotenv ? undefined : env.ALLOW_DRIZZLE_PUSH };
}

function readDotenv(): string {
  try { return readFileSync(join(process.cwd(), ".env"), "utf8"); } catch { return ""; }
}

export const envAtStart = allowFromShell(process.env, readDotenv());
