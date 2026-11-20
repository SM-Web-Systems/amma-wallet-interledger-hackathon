import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { applyCreditsV1 } from "./credits-v1";
import { applyBusinessWalletsV1 } from "./business-wallets-v1";
import { applyBusinessDepositsV1 } from "./business-deposits-v1";
import { activationDatabase, connectionOf } from "./activation.test-support";
import { evaluateSchema, readSchemaFacts, requiredMarkers } from "../schema-gate";

let pg: PGlite;
const apply = () => pg.transaction((tx) => applyBusinessDepositsV1(connectionOf(tx)));
const ready = async () => {
  pg = await activationDatabase();
  await pg.transaction((tx) => applyCreditsV1(connectionOf(tx)));
  await pg.transaction((tx) => applyBusinessWalletsV1(connectionOf(tx)));
};
afterEach(async () => { await pg?.close(); });
const WALLET = Keypair.random().publicKey();
const FROM = Keypair.random().publicKey();
const HASH = "a".repeat(64);
const held = (op: string, state = "held", reason: string | null = "no_bundle_matches_amount") => pg.query(
  `INSERT INTO business_deposits (tenant_id, network, wallet_address, operation_id, tx_hash, from_address, amount_xlm, received_at, state, held_reason)
   VALUES (1,'testnet',$1,$2,$3,$4,12.5,now(),$5,$6)`, [WALLET, op, HASH, FROM, state, reason]);

describe("guarded business-deposits-v1 storage", { timeout: 60_000 }, () => {
  it("requires business-wallets-v1", async () => {
    pg = await activationDatabase();
    await pg.transaction((tx) => applyCreditsV1(connectionOf(tx)));
    await expect(apply()).rejects.toThrow("business-wallets-v1 migration is required");
  });

  it("applies once, records its checksum, and a rerun reports already-applied", async () => {
    await ready();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    expect((await pg.query("SELECT version FROM amma_chain_migrations WHERE version='business-deposits-v1'")).rows).toHaveLength(1);
  });

  it("refuses a changed checksum and refuses drift", async () => {
    await ready(); await apply();
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='business-deposits-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
    await pg.close();
    await ready(); await apply();
    await pg.exec("ALTER TABLE business_deposits DROP CONSTRAINT business_deposits_once");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("a payment is recorded once, and a credited row must point at its ledger entry", async () => {
    await ready(); await apply();
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (1,'t','T')");
    await held("100");
    await expect(held("100")).rejects.toThrow();
    await expect(held("101", "credited", null)).rejects.toThrow();
    await expect(held("102", "held", null)).rejects.toThrow();
    await expect(pg.query("UPDATE business_wallets SET deposit_cursor = 'abc'")).resolves.toBeDefined(); // no rows, check not hit
  });

  it("the schema gate requires it only when BUSINESS_DEPOSITS is on", async () => {
    expect(requiredMarkers({ BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on" }).includes("business-deposits-v1")).toBe(false);
    expect(requiredMarkers({ BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on", BUSINESS_DEPOSITS: "on" }))
      .toEqual(expect.arrayContaining(["activation-v1", "credits-v1", "business-wallets-v1", "business-deposits-v1"]));
    await ready();
    const facts = async () => readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);
    const env = { BUSINESS_CREDITS: "on", BUSINESS_WALLETS: "on", BUSINESS_DEPOSITS: "on" } as NodeJS.ProcessEnv;
    expect(evaluateSchema(await facts(), env).problems.join(" ")).toContain("business-deposits-v1");
    await apply();
    expect(evaluateSchema(await facts(), env).problems.join(" ")).not.toContain("business-deposits-v1");
  });
});
