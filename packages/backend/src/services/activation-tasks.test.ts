import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { StrKey } from "@stellar/stellar-sdk";
import { activationDatabase, connectionOf } from "../db/migrations/activation.test-support";
import { applyActivationRequirementsV1 } from "../db/migrations/activation-requirements-v1";
vi.mock("../db", () => ({ db: {}, schema: {} }));
import { createTask, listTasks, parseRequirement, setTaskRequirement } from "./activation-tasks";
import { taskArgs } from "./activation-tasks-cli";

let pg: PGlite;
let db: any;
const CERTS = StrKey.encodeContract(Buffer.alloc(32, 5));
const q = async (text: string) => (await pg.query(text)).rows as any[];
const nft = { kind: "holds_nft" as const, contract: CERTS, network: "public" as const };
const base = { tenantId: 1, taskKey: "course:intro", name: "Intro", payer: "tenant" as const, dailyCap: null, totalCap: null, by: "owner" };

beforeAll(async () => { pg = await activationDatabase(); db = drizzle(pg); }, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => { await pg.exec("TRUNCATE tenants, audit_logs RESTART IDENTITY CASCADE; INSERT INTO tenants (id, slug, name) VALUES (1,'lms','LMS')"); });

describe("registering a business's tasks", () => {
  it("reads the rule from the command line, and refuses a half-written one", () => {
    expect(parseRequirement({})).toEqual({ kind: "signed_call" });
    expect(parseRequirement({ requirement: "nft", contract: CERTS, "nft-network": "public" })).toEqual(nft);
    expect(() => parseRequirement({ requirement: "nft", contract: CERTS })).toThrow("--nft-network");
    expect(() => parseRequirement({ requirement: "nft", contract: "GABC", "nft-network": "public" })).toThrow("--contract");
    expect(() => parseRequirement({ requirement: "signed-call", contract: CERTS })).toThrow("only go with");
    expect(() => parseRequirement({ requirement: "kyc" })).toThrow("signed-call or nft");
    const a = taskArgs(["create", "--tenant=1", "--key=lms:sponsor-onboarded", "--payer=amma", "--daily-cap=10", "--total-cap=10", "--by=owner"]);
    expect([a.key(), a.payer(), a.cap("daily-cap"), a.cap("total-cap")]).toEqual(["lms:sponsor-onboarded", "amma", 10, 10]);
    expect(() => taskArgs(["create", "--daily-cap=ten"]).cap("daily-cap")).toThrow("whole number");
    expect(() => taskArgs(["create", "--payer=lms"]).payer()).toThrow("--payer");
  });

  it("before the migration: a signed-call task can be made, an NFT rule can't", async () => {
    expect(await createTask(db, { ...base, requirement: { kind: "signed_call" } })).toEqual({ id: 1 });
    await expect(createTask(db, { ...base, taskKey: "x", requirement: nft } as any)).rejects.toThrow("activation-requirements-v1");
  });

  describe("after the migration", () => {
    beforeAll(async () => { await pg.transaction((tx) => applyActivationRequirementsV1(connectionOf(tx))); });

    it("makes a task with an NFT rule, audited, and shows it", async () => {
      await createTask(db, { ...base, requirement: nft });
      expect(await listTasks(db, 1)).toEqual([{ taskKey: "course:intro", name: "Intro", payer: "tenant", dailyCap: null, totalCap: null, active: true, requirement: "nft", contract: CERTS, network: "public" }]);
      expect((await q("SELECT detail FROM audit_logs WHERE action = 'activation_task_created'"))[0].detail).toMatchObject({ taskKey: "course:intro", requirement: "nft", contract: CERTS, by: "owner" });
    });

    it("an Amma-paid task needs both caps, and a key is used once per business", async () => {
      await expect(createTask(db, { ...base, payer: "amma", dailyCap: 10, requirement: { kind: "signed_call" } })).rejects.toThrow("--daily-cap and --total-cap");
      await createTask(db, { ...base, payer: "amma", dailyCap: 10, totalCap: 10, requirement: { kind: "signed_call" } });
      await expect(createTask(db, { ...base, requirement: { kind: "signed_call" } })).rejects.toThrow("already has a task");
    });

    it("changes a task's rule with a before-and-after audit, and does nothing when it's unchanged", async () => {
      await createTask(db, { ...base, requirement: { kind: "signed_call" } });
      expect(await setTaskRequirement(db, { tenantId: 1, taskKey: "course:intro", requirement: nft, by: "owner" })).toEqual({ changed: true });
      expect(await setTaskRequirement(db, { tenantId: 1, taskKey: "course:intro", requirement: nft, by: "owner" })).toEqual({ changed: false });
      expect(await setTaskRequirement(db, { tenantId: 1, taskKey: "course:intro", requirement: { kind: "signed_call" }, by: "owner" })).toEqual({ changed: true });
      const audits = await q("SELECT detail FROM audit_logs WHERE action = 'activation_task_requirement_set' ORDER BY id");
      expect(audits.map((a) => [a.detail.before.requirement, a.detail.after.requirement])).toEqual([["signed-call", "nft"], ["nft", "signed-call"]]);
      await expect(setTaskRequirement(db, { tenantId: 1, taskKey: "nope", requirement: nft, by: "owner" })).rejects.toThrow("No task");
    });
  });
});
