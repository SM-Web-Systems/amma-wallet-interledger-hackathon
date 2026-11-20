import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyCreditsV1 } from "./credits-v1";
import { applyBusinessControlsV1 } from "./business-controls-v1";
import { activationDatabase, connectionOf } from "./activation.test-support";
import { evaluateSchema, readSchemaFacts, requiredMarkers } from "../schema-gate";

let pg: PGlite;
const apply = () => pg.transaction((tx) => applyBusinessControlsV1(connectionOf(tx)));
const ready = async () => { pg = await activationDatabase(); await pg.transaction((tx) => applyCreditsV1(connectionOf(tx))); };
afterEach(async () => { await pg?.close(); });

describe("guarded business-controls-v1 storage", { timeout: 60_000 }, () => {
  it("requires credits-v1", async () => {
    pg = await activationDatabase();
    await expect(apply()).rejects.toThrow("credits-v1 migration is required");
  });

  it("applies once, a rerun reports already-applied, and it refuses a changed checksum or drift", async () => {
    await ready();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='business-controls-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
    await pg.close();
    await ready(); await apply();
    await pg.exec("ALTER TABLE business_activation_controls DROP CONSTRAINT business_controls_hold");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("a pause says who paused, a hold needs a below-floor date, and alerts are a known kind", async () => {
    await ready(); await apply();
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (1,'t','T')");
    await expect(pg.exec("INSERT INTO business_activation_controls (tenant_id, paused_at) VALUES (1, now())")).rejects.toThrow();
    await expect(pg.exec("INSERT INTO business_activation_controls (tenant_id, floor_hold_since) VALUES (1, now())")).rejects.toThrow();
    await pg.exec("INSERT INTO business_activation_controls (tenant_id, paused_at, paused_by) VALUES (1, now(), 'owner')");
    await expect(pg.exec("INSERT INTO business_alerts (tenant_id, kind) VALUES (1, 'something')")).rejects.toThrow();
    await pg.exec("INSERT INTO business_alerts (tenant_id, kind) VALUES (1, 'paused')");
  });

  it("the schema gate requires it only when BUSINESS_CONTROLS is on", async () => {
    expect(requiredMarkers({ BUSINESS_CREDITS: "on" }).includes("business-controls-v1")).toBe(false);
    expect(requiredMarkers({ BUSINESS_CREDITS: "on", BUSINESS_CONTROLS: "on" })).toEqual(expect.arrayContaining(["credits-v1", "business-controls-v1"]));
    await ready();
    const facts = async () => readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);
    const env = { BUSINESS_CREDITS: "on", BUSINESS_CONTROLS: "on" } as NodeJS.ProcessEnv;
    expect(evaluateSchema(await facts(), env).problems.join(" ")).toContain("business-controls-v1");
    await apply();
    expect(evaluateSchema(await facts(), env).problems.join(" ")).not.toContain("business-controls-v1");
  });
});
