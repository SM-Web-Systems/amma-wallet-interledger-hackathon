import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { allowFromShell, drizzleCommandRefusal } from "./drizzle-guard";

// `drizzle-kit push` drops every table that is absent from the Drizzle schema
// and not excluded by tablesFilter. Without a TTY it does this unprompted, so
// a raw-SQL migration table missing from the filter would be deleted by deploy.
const root = join(__dirname, "..", "..");
const config = readFileSync(join(root, "drizzle.config.ts"), "utf8");
const filter = JSON.parse((/tablesFilter:\s*(\[[^\]]*\])/.exec(config)?.[1] ?? "[]").replace(/'/g, '"')) as string[];
const glob = (pattern: string, name: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name);
const kept = (name: string) => (!filter.length || filter.some(p => !p.startsWith("!") && glob(p, name))) && !filter.some(p => p.startsWith("!") && glob(p.slice(1), name));

describe("drizzle push guard", () => {
  const drizzleTables = new Set(Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => v instanceof PgTable).map(t => getTableConfig(t).name));
  const dir = join(__dirname, "migrations");
  const rawTables = new Set(readdirSync(dir).filter(f => /\.(sql|ts)$/.test(f) && !f.endsWith(".test.ts"))
    .flatMap(f => [...readFileSync(join(dir, f), "utf8").matchAll(/CREATE TABLE IF NOT EXISTS\s+"?([a-z_][a-z0-9_]*)"?/gi)].map(m => m[1])));

  it("finds the raw-SQL payment ledger and migration marker tables", () => {
    expect([...rawTables]).toEqual(expect.arrayContaining(["payment_ledger", "payment_accounts", "amma_chain_migrations"]));
  });
  it("excludes every raw-SQL table that Drizzle does not manage from push", () => {
    const exposed = [...rawTables].filter(name => !drizzleTables.has(name) && kept(name));
    expect(exposed).toEqual([]);
  });
  it("still lets push manage the Drizzle schema tables", () => {
    expect([...drizzleTables].filter(name => !kept(name))).toEqual([]);
  });
});

// push also drops columns, indexes and CHECK constraints that a raw-SQL migration added to a Drizzle-managed table
// when the Drizzle schema does not declare them (custody-v2's derivation_index is the one custody signing reads).
describe("drizzle push guard: columns, indexes and checks", () => {
  type Added = { kind: "column" | "check" | "index"; table: string; name: string };
  const configs = new Map(Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => v instanceof PgTable).map((t) => [getTableConfig(t).name, getTableConfig(t)]));
  const migrationsDir = join(__dirname, "migrations");
  const files = [
    ...readdirSync(migrationsDir).filter((f) => /\.(sql|ts)$/.test(f) && !f.endsWith(".test.ts") && !f.includes("test-support")).map((f) => join(migrationsDir, f)),
    ...readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).map((f) => join(root, "migrations", f)),
  ];
  const added: Added[] = files.flatMap((file) => {
    const src = readFileSync(file, "utf8").replace(/--.*$/gm, "");
    const out: Added[] = [];
    for (const m of src.matchAll(/ALTER TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?([\s\S]*?);/gi)) {
      for (const c of m[2].matchAll(/ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?/gi)) out.push({ kind: "column", table: m[1], name: c[1] });
      for (const c of m[2].matchAll(/ADD CONSTRAINT\s+"?([a-z_][a-z0-9_]*)"?\s+CHECK/gi)) out.push({ kind: "check", table: m[1], name: c[1] });
    }
    for (const m of src.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?(?:\s+IF NOT EXISTS)?\s+"?([a-z_][a-z0-9_]*)"?\s+ON\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      out.push({ kind: "index", table: m[2], name: m[1] });
    }
    return out;
  });

  it("finds the custody-v2 column, index and check on user_wallets", () => {
    expect(added).toEqual(expect.arrayContaining([
      { kind: "column", table: "user_wallets", name: "derivation_index" },
      { kind: "index", table: "user_wallets", name: "idx_user_wallets_derivation" },
      { kind: "check", table: "user_wallets", name: "user_wallets_derivation_index_check" },
    ]));
  });

  it("declares in Drizzle every column, index and CHECK a raw-SQL migration adds to a Drizzle-managed table", () => {
    const missing = added.filter(({ kind, table, name }) => {
      const c = configs.get(table);
      if (!c) return false; // a raw-SQL table: the tablesFilter test above covers it
      if (kind === "column") return !c.columns.some((x) => x.name === name);
      if (kind === "check") return !c.checks.some((x) => x.name === name);
      return !c.indexes.some((x) => x.config.name === name);
    }).map((x) => `${x.kind} ${x.table}.${x.name}`);
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe("drizzle-kit command guard", () => {
  it("refuses push, migrate, up and drop unless ALLOW_DRIZZLE_PUSH=1", () => {
    for (const cmd of ["push", "migrate", "up", "drop"]) {
      expect(drizzleCommandRefusal(["node", "drizzle-kit", cmd, "--force"], {})).toMatch(new RegExp(`drizzle-kit ${cmd} is blocked`));
      expect(drizzleCommandRefusal(["node", "drizzle-kit", cmd], { ALLOW_DRIZZLE_PUSH: "true" })).toMatch(/blocked/);
      expect(drizzleCommandRefusal(["node", "drizzle-kit", cmd], { ALLOW_DRIZZLE_PUSH: "1" })).toBeNull();
    }
  });
  it("lets generate and studio run", () => {
    expect(drizzleCommandRefusal(["node", "drizzle-kit", "generate"], {})).toBeNull();
    expect(drizzleCommandRefusal(["node", "drizzle-kit", "studio"], {})).toBeNull();
  });
  it("is wired into drizzle.config.ts before defineConfig", () => {
    expect(config).toMatch(/drizzleCommandRefusal\(process\.argv, envAtStart\)[\s\S]*throw new Error\(refused\)[\s\S]*export default defineConfig/);
  });
  it("does not honour ALLOW_DRIZZLE_PUSH when packages/backend/.env defines it (drizzle-kit loads .env before the config)", () => {
    expect(allowFromShell({ ALLOW_DRIZZLE_PUSH: "1" }, "DATABASE_URL=x\nALLOW_DRIZZLE_PUSH=1\n")).toEqual({ ALLOW_DRIZZLE_PUSH: undefined });
    expect(allowFromShell({ ALLOW_DRIZZLE_PUSH: "1" }, "  export ALLOW_DRIZZLE_PUSH = 1")).toEqual({ ALLOW_DRIZZLE_PUSH: undefined });
    expect(allowFromShell({ ALLOW_DRIZZLE_PUSH: "1" }, "DATABASE_URL=x\n# ALLOW_DRIZZLE_PUSH=1\n")).toEqual({ ALLOW_DRIZZLE_PUSH: "1" });
    expect(allowFromShell({ ALLOW_DRIZZLE_PUSH: "1" }, "")).toEqual({ ALLOW_DRIZZLE_PUSH: "1" });
    expect(drizzleCommandRefusal(["node", "drizzle-kit", "push"], allowFromShell({ ALLOW_DRIZZLE_PUSH: "1" }, "ALLOW_DRIZZLE_PUSH=1"))).toMatch(/blocked/);
    expect(config).not.toMatch(/drizzleCommandRefusal(process.argv, process.env)/);
  });
  it("has no npm script that pushes or migrates with drizzle-kit", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(Object.entries(pkg.scripts).filter(([, s]) => /drizzle-kit\s+(push|migrate|up|drop)\b/.test(s))).toEqual([]);
  });
  it("lets CI push only on its disposable test database step", () => {
    const ci = readFileSync(join(root, "..", "..", ".github", "workflows", "ci.yml"), "utf8");
    const pushes = ci.split("\n").filter((l) => /drizzle-kit\s+push/.test(l));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].trim()).toBe('ALLOW_DRIZZLE_PUSH=1 DATABASE_URL="$url" npx drizzle-kit push --force');
  });
});
