import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyCreditsV1 } from "./credits-v1";
import { activationDatabase, connectionOf, databaseUpToCustodyV5 } from "./activation.test-support";
import { evaluateSchema, readSchemaFacts, requiredMarkers } from "../schema-gate";
import { bundleQuote } from "../../services/credit-plans";

let pg: PGlite;
const apply = () => pg.transaction((tx) => applyCreditsV1(connectionOf(tx)));
afterEach(async () => { await pg?.close(); });

const OLD_TIERS = `INSERT INTO bundle_catalog (slug, name, approx_users, price_xlm, is_active, sort_order) VALUES
  ('starter-100','Starter 100',100,300.0,true,1), ('starter-200','Starter 200',200,600.0,true,2),
  ('growth-500','Growth 500',500,1500.0,true,3), ('scale-1000','Scale 1000',1000,3000.0,true,4), ('custom','Custom',NULL,NULL,true,5)`;

describe("guarded credits-v1 storage", { timeout: 60_000 }, () => {
  it("requires activation-v1", async () => {
    pg = await databaseUpToCustodyV5();
    await expect(apply()).rejects.toThrow("activation-v1 migration is required");
  });

  it("applies once, records its checksum, and a rerun reports already-applied", async () => {
    pg = await activationDatabase();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='credits-v1'")).rows).toHaveLength(1);
  });

  it("retires the 3 XLM tiers, keeps custom, and adds the owner's monthly and annual prices", async () => {
    pg = await activationDatabase();
    await pg.exec(OLD_TIERS);
    await apply();
    const rows = (await pg.query<{ slug: string; plan: string | null; users: number | null; price: string | null; active: boolean }>(
      "SELECT slug, plan, users, price_xlm::text AS price, is_active AS active FROM bundle_catalog ORDER BY sort_order")).rows;
    expect(rows.filter((r) => r.active).map((r) => r.slug)).toEqual(["custom", "monthly-100", "monthly-200", "monthly-500", "monthly-1000", "annual-100", "annual-200", "annual-500", "annual-1000"]);
    expect(rows.filter((r) => !r.active).map((r) => r.slug)).toEqual(["starter-100", "starter-200", "growth-500", "scale-1000"]);
    // The catalog prices and the pricing code agree.
    for (const r of rows.filter((x) => x.plan)) expect(r.price).toBe(bundleQuote(r.plan as "monthly" | "annual", Number(r.users)).total);
  });

  it("refuses a changed checksum", async () => {
    pg = await activationDatabase(); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='credits-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
  });

  it("refuses drift: a repriced bundle, a loosened credit check, a dropped ledger unique", async () => {
    pg = await activationDatabase(); await apply();
    await pg.exec("UPDATE bundle_catalog SET price_xlm = 300 WHERE slug = 'monthly-100'");
    await expect(apply()).rejects.toThrow("schema drift");
    await pg.close();
    pg = await activationDatabase(); await apply();
    await pg.exec("ALTER TABLE tenant_credit_balances DROP CONSTRAINT tenant_credit_balances_funding_xlm_check");
    await expect(apply()).rejects.toThrow("schema drift");
    await pg.close();
    pg = await activationDatabase(); await apply();
    await pg.exec("ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_once");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("never lets credits or funding go negative, and a ledger key is used once per business", async () => {
    pg = await activationDatabase(); await apply();
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (1,'t','T'); INSERT INTO tenant_credit_balances (tenant_id, monthly_credits, funding_xlm) VALUES (1, 1, 1.1)");
    await expect(pg.exec("UPDATE tenant_credit_balances SET monthly_credits = monthly_credits - 2")).rejects.toThrow();
    await expect(pg.exec("UPDATE tenant_credit_balances SET funding_xlm = funding_xlm - 2.2")).rejects.toThrow();
    const row = "(1, 'bundle_credit', 'monthly', 100, 'deposit-abc-123', 'test')";
    await pg.exec(`INSERT INTO credit_ledger (tenant_id, event, plan, monthly_credits_delta, idempotency_key, created_by) VALUES ${row}`);
    await expect(pg.exec(`INSERT INTO credit_ledger (tenant_id, event, plan, monthly_credits_delta, idempotency_key, created_by) VALUES ${row}`)).rejects.toThrow();
  });

  it("an annual wallet needs its paid-until date, a monthly one must not have one", async () => {
    pg = await activationDatabase(); await apply();
    const check = (await pg.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='wallet_activations_credit_plan'")).rows;
    expect(check).toHaveLength(1);
    expect(check[0].def).toContain("annual");
  });

  it("the schema gate requires it only when BUSINESS_CREDITS is on", async () => {
    expect(requiredMarkers({}).includes("credits-v1")).toBe(false);
    expect(requiredMarkers({ BUSINESS_CREDITS: "on" })).toEqual(expect.arrayContaining(["activation-v1", "credits-v1"]));
    pg = await activationDatabase();
    const facts = async () => readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);
    const env = { BUSINESS_CREDITS: "on" } as NodeJS.ProcessEnv;
    expect(evaluateSchema(await facts(), env).problems.join(" ")).toContain("credits-v1");
    await apply();
    expect(evaluateSchema(await facts(), env).problems.join(" ")).not.toContain("credits-v1");
  });
});
