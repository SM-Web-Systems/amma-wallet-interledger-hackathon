/**
 * Operator commands for a business's activation controls and balance floor (stage 5).
 *
 *   npm run business-controls -- show --tenant=1
 *   npm run business-controls -- pause --tenant=1 --by=NAME
 *   npm run business-controls -- resume --tenant=1 --by=NAME
 *   npm run business-controls -- set-daily-cap --tenant=1 --cap=50 --by=NAME
 *   npm run business-controls -- check-floor [--tenant=1]
 *
 * Pause, resume and the floor check email the business and BUSINESS_ESCALATION_EMAIL. Every change is audited.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { resolveDatabaseUrl } from "../lib/docker-secrets";
import { sendEmail } from "../lib/mailer";
import { parseArgs } from "./business-wallets-cli";
import { checkFloors, controlsView, pauseActivations, resumeActivations, setDailyCap } from "./business-controls";

const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");

export function controlArgs(argv: string[], env: Record<string, string | undefined> = process.env) {
  const a = parseArgs(argv);
  const cap = () => { const raw = a.options.cap ?? ""; if (!/^\d{1,4}$/.test(raw)) throw new Error("--cap=N is required, a whole number"); return Number(raw); };
  const owner = () => { const e = (env.BUSINESS_ESCALATION_EMAIL ?? "").trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error("BUSINESS_ESCALATION_EMAIL is needed for the owner's copy of alerts"); return e; };
  return { ...a, cap, owner };
}

async function main() {
  const args = controlArgs(process.argv.slice(2));
  const client = postgres(resolveDatabaseUrl(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  const db = drizzle(client) as any;
  const deps = () => ({ mail: async (to: string, s: string, h: string) => Boolean(await sendEmail(to, s, h)), ownerEmail: args.owner(), now: new Date() });
  try {
    switch (args.command) {
      case "show": out(await controlsView(db, args.tenant())); break;
      case "pause": out(await pauseActivations(db, deps(), { tenantId: args.tenant(), by: args.by() })); break;
      case "resume": out(await resumeActivations(db, deps(), { tenantId: args.tenant(), by: args.by() })); break;
      case "set-daily-cap": out(await setDailyCap(db, { now: new Date() }, { tenantId: args.tenant(), dailyCap: args.cap(), by: args.by() })); break;
      case "check-floor": out(await checkFloors(db, { ...deps(), ...(args.options.tenant ? { tenantId: args.tenant() } : {}) })); break;
      default: throw new Error("Commands: show, pause, resume, set-daily-cap, check-floor");
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (require.main === module) {
  // Only our own messages are printed: a database error could carry a connection string.
  main().catch((e) => { process.stderr.write(`${e instanceof Error && !/postgres(ql)?:\/\//i.test(e.message) ? e.message : "Command failed"}\n`); process.exitCode = 1; });
}
