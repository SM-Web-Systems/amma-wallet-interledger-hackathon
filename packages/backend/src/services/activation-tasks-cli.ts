/**
 * Operator commands for a business's activation tasks and their activation requirement.
 *
 *   npm run activation-tasks -- create --tenant=1 --key=course:intro --name="Intro course" --payer=tenant --by=NAME
 *       [--daily-cap=N --total-cap=N] [--requirement=nft --contract=C... --nft-network=public|testnet]
 *   npm run activation-tasks -- set-requirement --tenant=1 --key=course:intro --by=NAME --requirement=nft --contract=C... --nft-network=public
 *   npm run activation-tasks -- set-requirement --tenant=1 --key=course:intro --by=NAME --requirement=signed-call
 *   npm run activation-tasks -- show --tenant=1
 *
 * Without --requirement a task is "signed call only". Every change is audited.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveDatabaseUrl } from "../lib/docker-secrets";
import { parseArgs } from "./business-wallets-cli";
import { createTask, listTasks, parseRequirement, setTaskRequirement } from "./activation-tasks";

const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

export function taskArgs(argv: string[]) {
  const a = parseArgs(argv);
  const key = () => { if (!a.options.key) throw new Error("--key=TASK_KEY is required"); return a.options.key; };
  const cap = (name: "daily-cap" | "total-cap") => {
    const raw = a.options[name];
    if (raw === undefined) return null;
    if (!/^\d{1,9}$/.test(raw)) throw new Error(`--${name} must be a whole number`);
    return Number(raw);
  };
  const payer = (): "tenant" | "amma" => { const p = a.options.payer ?? "tenant"; if (p !== "tenant" && p !== "amma") throw new Error("--payer=tenant|amma"); return p; };
  return { ...a, key, cap, payer };
}

async function main() {
  const args = taskArgs(process.argv.slice(2));
  const client = postgres(resolveDatabaseUrl(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  const db = drizzle(client) as any;
  try {
    switch (args.command) {
      case "create":
        out(await createTask(db, { tenantId: args.tenant(), taskKey: args.key(), name: args.options.name ?? "", payer: args.payer(),
          dailyCap: args.cap("daily-cap"), totalCap: args.cap("total-cap"), requirement: parseRequirement(args.options), by: args.by() }));
        break;
      case "set-requirement":
        if (!args.options.requirement) throw new Error("--requirement=signed-call|nft is required");
        out(await setTaskRequirement(db, { tenantId: args.tenant(), taskKey: args.key(), requirement: parseRequirement(args.options), by: args.by() }));
        break;
      case "show":
        out(await listTasks(db, args.tenant()));
        break;
      default:
        throw new Error("Commands: create, set-requirement, show");
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (require.main === module) {
  // Only our own messages are printed: a database error could carry a connection string.
  main().catch((e) => { process.stderr.write(`${e instanceof Error && !/postgres(ql)?:\/\//i.test(e.message) ? e.message : "Command failed"}\n`); process.exitCode = 1; });
}
