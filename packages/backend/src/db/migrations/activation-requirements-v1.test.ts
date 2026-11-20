import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { applyActivationRequirementsV1 } from "./activation-requirements-v1";
import { activationDatabase, connectionOf, databaseUpToCustodyV5 } from "./activation.test-support";
import { evaluateSchema, readSchemaFacts } from "../schema-gate";

let pg: PGlite;
const apply = () => pg.transaction((tx) => applyActivationRequirementsV1(connectionOf(tx)));
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
afterEach(async () => { await pg?.close(); });
const task = (key: string, kind: string, contract: string | null, network: string | null) => pg.query(
  "INSERT INTO partner_tasks (tenant_id, task_key, name, chains, created_by, requirement_kind, requirement_contract, requirement_network) VALUES (1,$1,'T','{stellar}','t',$2,$3,$4)", [key, kind, contract, network]);

describe("guarded activation-requirements-v1 storage", { timeout: 60_000 }, () => {
  it("requires activation-v1", async () => {
    pg = await databaseUpToCustodyV5();
    await expect(apply()).rejects.toThrow("activation-v1 migration is required");
  });

  it("applies once, a rerun reports already-applied, and it refuses a changed checksum or drift", async () => {
    pg = await activationDatabase();
    expect(await apply()).toBe("applied");
    expect(await apply()).toBe("already-applied");
    await pg.exec("UPDATE amma_chain_migrations SET checksum='bad' WHERE version='activation-requirements-v1'");
    await expect(apply()).rejects.toThrow("checksum mismatch");
    await pg.close();
    pg = await activationDatabase(); await apply();
    await pg.exec("ALTER TABLE partner_tasks DROP CONSTRAINT partner_tasks_requirement");
    await expect(apply()).rejects.toThrow("schema drift");
  });

  it("existing tasks stay signed-call only, and a rule must be whole: an NFT rule needs a contract id and a network", async () => {
    pg = await activationDatabase();
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (1,'t','T'); INSERT INTO partner_tasks (tenant_id, task_key, name, chains, created_by) VALUES (1,'old','Old','{stellar}','t')");
    await apply();
    expect((await pg.query<any>("SELECT requirement_kind, requirement_contract FROM partner_tasks")).rows).toEqual([{ requirement_kind: "signed_call", requirement_contract: null }]);
    await task("nft", "holds_nft", CONTRACT, "public");
    await expect(task("a", "holds_nft", null, "public")).rejects.toThrow();
    await expect(task("b", "holds_nft", CONTRACT, null)).rejects.toThrow();
    await expect(task("c", "holds_nft", "GABC", "public")).rejects.toThrow();
    await expect(task("d", "holds_nft", CONTRACT, "mainnet")).rejects.toThrow();
    await expect(task("e", "signed_call", CONTRACT, null)).rejects.toThrow();
    await expect(task("f", "anything", null, null)).rejects.toThrow();
  });

  it("the schema gate knows the marker, so a database with it applied still passes", async () => {
    pg = await activationDatabase(); await apply();
    const facts = await readSchemaFacts(async <T extends Record<string, unknown>>(s: string) => (await pg.query(s)).rows as T[]);
    expect(evaluateSchema(facts, { TASK_ACTIVATION: "on" } as NodeJS.ProcessEnv).problems.join(" ")).not.toContain("activation-requirements-v1");
  });
});
