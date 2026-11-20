import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { applyCreditsV1 } from "./credits-v1";
import { applyBusinessWalletsV1 } from "./business-wallets-v1";
import { activationDatabase, connectionOf } from "./activation.test-support";
import { evaluateSchema, readSchemaFacts, requiredMarkers } from "../schema-gate";

let pg: PGlite;
const apply = () => pg.transaction((tx) => applyBusinessWalletsV1(connectionOf(tx)));
const ready = async () => { pg = await activationDatabase(); await pg.transaction((tx) => applyCreditsV1(connectionOf(tx))); };
afterEach(async () => { await pg?.close(); });

const KEYS = Array.from({ length: 3 }, () => Keypair.random().publicKey());
const G = (n: number) => KEYS[n];

describe("guarded business-wallets-v1 storage", { timeout: 60_000 }, () => {
  it("requires credits-v1", async () => {
    pg = await activationDatabase();
    await expect(apply()).rejects.toThrow("credits-v1 migration is required");
  });

  it("applies once, records its checksum, and a rerun reports already-applied", async () => {
    await ready();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='business-wallets-v1'")).rows).toHaveLength(1);
  });

  it("refuses a changed checksum and refuses drift", async () => {
    await ready(); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='business-wallets-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
    await pg.close();
    await ready(); await apply();
    await pg.exec("DROP INDEX business_wallets_one_live");
    await expect(apply()).rejects.toThrow("schema drift");
    await pg.close();
    await ready(); await apply();
    await pg.exec("ALTER TABLE fee_address_pool DROP CONSTRAINT fee_address_pool_address_unique");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("one live wallet per business and network; a retired one can be replaced", async () => {
    await ready(); await apply();
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (1,'t','T')");
    const add = (n: number) => pg.query("INSERT INTO business_wallets (tenant_id, network, address, sealed_secret, provider, created_by) VALUES (1,'testnet',$1,$2,'local','test')", [G(n), "x".repeat(60)]);
    await add(1);
    await expect(add(2)).rejects.toThrow();
    await pg.exec("UPDATE business_wallets SET retired_at = now()");
    await add(2);
    await expect(pg.query("INSERT INTO business_wallets (tenant_id, network, address, sealed_secret, provider, created_by) VALUES (1,'public','SNOTAPUBLICKEY','x','local','test')")).rejects.toThrow();
  });

  it("a fee address belongs to at most one business, which has one per network, and assignment needs both fields", async () => {
    await ready(); await apply();
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (1,'a','A'), (2,'b','B')");
    await pg.query("INSERT INTO fee_address_pool (network, address, added_by) VALUES ('public',$1,'t'), ('public',$2,'t')", [G(1), G(2)]);
    await expect(pg.query("INSERT INTO fee_address_pool (network, address, added_by) VALUES ('testnet',$1,'t')", [G(1)])).rejects.toThrow();
    await pg.query("UPDATE fee_address_pool SET tenant_id = 1, assigned_at = now() WHERE address = $1", [G(1)]);
    await expect(pg.query("UPDATE fee_address_pool SET tenant_id = 1, assigned_at = now() WHERE address = $1", [G(2)])).rejects.toThrow();
    await expect(pg.query("UPDATE fee_address_pool SET tenant_id = 2 WHERE address = $1", [G(2)])).rejects.toThrow();
  });

  it("the schema gate requires it only when BUSINESS_WALLETS is on", async () => {
    expect(requiredMarkers({ BUSINESS_CREDITS: "on" }).includes("business-wallets-v1")).toBe(false);
    expect(requiredMarkers({ BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on" })).toEqual(expect.arrayContaining(["activation-v1", "credits-v1", "business-wallets-v1"]));
    await ready();
    const facts = async () => readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);
    const env = { BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on" } as NodeJS.ProcessEnv;
    expect(evaluateSchema(await facts(), env).problems.join(" ")).toContain("business-wallets-v1");
    await apply();
    expect(evaluateSchema(await facts(), env).problems.join(" ")).not.toContain("business-wallets-v1");
  });
});
