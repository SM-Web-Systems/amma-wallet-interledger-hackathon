import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { applyCreditsV1 } from "./credits-v1";
import { applyBusinessWalletsV1 } from "./business-wallets-v1";
import { applyBusinessDepositsV1 } from "./business-deposits-v1";
import { applyFeeSweepsV1 } from "./fee-sweeps-v1";
import { activationDatabase, connectionOf } from "./activation.test-support";
import { evaluateSchema, readSchemaFacts, requiredMarkers } from "../schema-gate";

let pg: PGlite;
const apply = () => pg.transaction((tx) => applyFeeSweepsV1(connectionOf(tx)));
const ready = async () => {
  pg = await activationDatabase();
  for (const a of [applyCreditsV1, applyBusinessWalletsV1, applyBusinessDepositsV1]) await pg.transaction((tx) => a(connectionOf(tx)));
};
afterEach(async () => { await pg?.close(); });

describe("guarded fee-sweeps-v1 storage", { timeout: 60_000 }, () => {
  it("requires business-deposits-v1", async () => {
    pg = await activationDatabase();
    await expect(apply()).rejects.toThrow("business-deposits-v1 migration is required");
  });

  it("applies once, a rerun reports already-applied, and it refuses a changed checksum or drift", async () => {
    await ready();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='fee-sweeps-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
    await pg.close();
    await ready(); await apply();
    await pg.exec("ALTER TABLE fee_sweeps DROP CONSTRAINT fee_sweeps_once");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("each source is swept once, and a confirmed sweep needs its hash, time and destination", async () => {
    await ready(); await apply();
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (1,'t','T')");
    const add = () => pg.exec("INSERT INTO fee_sweeps (tenant_id, network, source_ref, amount_xlm) VALUES (1,'testnet','deposit:7',200)");
    await add();
    await expect(add()).rejects.toThrow();
    await expect(pg.exec("UPDATE fee_sweeps SET state = 'confirmed'")).rejects.toThrow();
    await expect(pg.exec("INSERT INTO fee_sweeps (tenant_id, network, source_ref, amount_xlm) VALUES (1,'testnet','other:1',1)")).rejects.toThrow();
  });

  it("the schema gate requires it only when BUSINESS_FEE_SWEEPS is on", async () => {
    const base = { BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on", BUSINESS_DEPOSITS: "on" };
    expect(requiredMarkers(base).includes("fee-sweeps-v1")).toBe(false);
    expect(requiredMarkers({ ...base, BUSINESS_FEE_SWEEPS: "on" })).toEqual(expect.arrayContaining(["business-deposits-v1", "fee-sweeps-v1"]));
    await ready();
    const facts = async () => readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);
    const env = { ...base, BUSINESS_FEE_SWEEPS: "on" } as NodeJS.ProcessEnv;
    expect(evaluateSchema(await facts(), env).problems.join(" ")).toContain("fee-sweeps-v1");
    await apply();
    expect(evaluateSchema(await facts(), env).problems.join(" ")).not.toContain("fee-sweeps-v1");
  });
});
