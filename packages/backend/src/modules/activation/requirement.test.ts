import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { activationDatabase, connectionOf } from "../../db/migrations/activation.test-support";
import { applyActivationRequirementsV1 } from "../../db/migrations/activation-requirements-v1";
import { seedActivation, validBody } from "./activation.test-support";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../../db", async () => ({ get db() { return state.db; }, schema: await import("../../db/schema") }));
vi.mock("../../lib/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("../../services/billing.service", async (orig) => ({ ...(await orig<typeof import("../../services/billing.service")>()), maybeNotifyDeficit: vi.fn(async () => undefined) }));

import { submitActivation, type IntakeDeps } from "./intake";
import { holdingFrom, requirementOf, type Holding, type NftHolding } from "./requirement";
import type { PartnerContext } from "./partner-auth";
import type { ActivationFlags } from "../../lib/activation-flags";

let pg: PGlite;
const flags: ActivationFlags = { enabled: true, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: 11_000_000n, globalDailyCap: 1000, userDailyCap: 3 };
const partner: PartnerContext = { tenantId: 1, tenantName: "LMS", apiKeyId: 1, signingKeyId: 1, dailyCap: 50, allowDebt: false };
const CERTS = StrKey.encodeContract(Buffer.alloc(32, 9));
const LEARNER = Keypair.random().publicKey();
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n);

let reads: { contract: string; network: string; address: string }[] = [];
let answer: Holding | Error = "holds";
const holding: NftHolding = async (contract, network, address) => {
  reads.push({ contract, network, address });
  if (answer instanceof Error) throw answer;
  return answer;
};
const deps = (over: Partial<IntakeDeps> = {}): IntakeDeps => ({ db: state.db, flags, now: () => new Date(), paused: () => false, custodyAllowed: () => true, frozen: async () => false, nftHolding: holding, ...over });
const submit = (body = validBody(), d: Partial<IntakeDeps> = {}) => submitActivation(deps(d), partner, body);
const fails = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return `${(e as any).code}:${(e as any).status}:${(e as any).retryable}`; } };
const requireNft = (network = "public") => pg.query("UPDATE partner_tasks SET requirement_kind = 'holds_nft', requirement_contract = $1, requirement_network = $2", [CERTS, network]);
const rejection = async () => (await q("SELECT detail FROM audit_logs WHERE action = 'activation_rejected' ORDER BY id DESC LIMIT 1"))[0]?.detail;

beforeAll(async () => {
  pg = await activationDatabase();
  state.db = drizzle(pg);
}, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  reads = []; answer = "holds";
  await seedActivation(pg);
  await pg.query("UPDATE user_wallets SET public_key = $1 WHERE user_id = 1", [LEARNER]);
});

describe("before activation-requirements-v1 is applied", () => {
  it("every task is signed-call only and the chain is never read", async () => {
    expect((await submit()).status).toBe(202);
    expect(reads).toEqual([]);
  });
});

describe("activation requirement per task", () => {
  beforeAll(async () => { await pg.transaction((tx) => applyActivationRequirementsV1(connectionOf(tx))); });

  it("a signed-call task activates as before without reading the chain", async () => {
    expect((await submit()).status).toBe(202);
    expect(reads).toEqual([]);
  });

  it("an NFT task activates a learner who holds the certificate, checked on the rule's own network with the learner's address", async () => {
    await requireNft("public");
    expect((await submit()).status).toBe(202);
    expect(reads).toEqual([{ contract: CERTS, network: "public", address: LEARNER }]);
    expect((await q("SELECT detail FROM audit_logs WHERE action = 'activation_requested'"))[0].detail.requirement).toEqual({ nft: CERTS, network: "public" });
  });

  it("refuses a learner without the certificate with REQUIREMENT_NOT_MET, and nothing is written or charged", async () => {
    await requireNft();
    answer = "none";
    const before = (await q("SELECT prepaid_xlm_balance::text AS b FROM tenants WHERE id = 1"))[0].b;
    expect(await fails(submit())).toBe("REQUIREMENT_NOT_MET:403:false");
    expect(await count("partner_task_completions")).toBe(0);
    expect(await count("wallet_activations")).toBe(0);
    expect(await count("billing_events")).toBe(0);
    expect((await q("SELECT prepaid_xlm_balance::text AS b FROM tenants WHERE id = 1"))[0].b).toBe(before);
    expect(await rejection()).toMatchObject({ code: "REQUIREMENT_NOT_MET", reason: "no_token" });
  });

  it("a contract that won't answer is not met (and says why in the audit); a chain fault is retryable, never a yes or a no", async () => {
    await requireNft();
    answer = "refused";
    expect(await fails(submit())).toBe("REQUIREMENT_NOT_MET:403:false");
    expect(await rejection()).toMatchObject({ reason: "contract_refused" });
    answer = new Error("rpc down");
    expect(await fails(submit())).toBe("REQUIREMENT_CHECK_UNAVAILABLE:503:true");
    expect(await count("wallet_activations")).toBe(0);
    expect(await fails(submit(validBody(), { nftHolding: undefined }))).toBe("REQUIREMENT_CHECK_UNAVAILABLE:503:true");
  });

  it("a learner with no valid Amma-held Stellar address is not met", async () => {
    await requireNft();
    await pg.query("UPDATE user_wallets SET public_key = 'GBNOTAKEY' WHERE user_id = 1");
    expect(await fails(submit())).toBe("REQUIREMENT_NOT_MET:403:false");
    expect(await rejection()).toMatchObject({ reason: "no_stellar_address" });
    expect(reads).toEqual([]);
  });

  it("doesn't read the chain for a user this partner doesn't have; the usual NOT_ELIGIBLE answer comes first", async () => {
    await requireNft();
    await pg.exec("DELETE FROM tenant_users");
    expect(await fails(submit())).toBe("NOT_ELIGIBLE:403:false");
    expect(reads).toEqual([]);
  });

  it("a replayed request returns the original result without reading the chain again, even if the NFT has since moved", async () => {
    await requireNft();
    expect((await submit()).status).toBe(202);
    answer = "none"; reads = [];
    expect((await submit()).status).toBe(200);
    expect(reads).toEqual([]);
  });

  it("a rule changed while the chain was being read is not trusted: the call is retryable", async () => {
    await requireNft("public");
    const switching: NftHolding = async () => { await pg.query("UPDATE partner_tasks SET requirement_network = 'testnet'"); return "holds"; };
    expect(await fails(submit(validBody(), { nftHolding: switching }))).toBe("REQUIREMENT_CHECK_UNAVAILABLE:503:true");
    expect(await rejection()).toMatchObject({ reason: "requirement_changed" });
    expect(await count("wallet_activations")).toBe(0);
  });
});

describe("reading a rule and a balance", () => {
  it("an unknown or half-written rule is never read as no rule", () => {
    expect(requirementOf({})).toEqual({ kind: "signed_call" });
    expect(requirementOf({ requirement_kind: "signed_call" })).toEqual({ kind: "signed_call" });
    expect(requirementOf({ requirement_kind: "holds_nft", requirement_contract: CERTS, requirement_network: "testnet" })).toEqual({ kind: "holds_nft", contract: CERTS, network: "testnet" });
    expect(requirementOf({ requirement_kind: "holds_nft" }).kind).toBe("holds_nft");
    expect(requirementOf({ requirement_kind: "something_new" }).kind).toBe("holds_nft");
  });
  it("a SEP-50 balance above zero holds", () => {
    expect(holdingFrom(1)).toBe("holds");
    expect(holdingFrom(3n)).toBe("holds");
    expect(holdingFrom(0)).toBe("none");
    expect(holdingFrom("1")).toBe("refused");
    expect(holdingFrom(null)).toBe("refused");
  });
});
