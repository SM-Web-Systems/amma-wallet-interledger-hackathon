import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { activationDatabase, connectionOf } from "../../db/migrations/activation.test-support";
import { applyCreditsV1 } from "../../db/migrations/credits-v1";
import { ADDRESS, ADDRESS_2, seedActivation, validBody } from "./activation.test-support";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../../db", async () => ({ get db() { return state.db; }, schema: await import("../../db/schema") }));
vi.mock("../../lib/mailer", () => ({ sendEmail: vi.fn() }));

import { submitActivation, type IntakeDeps } from "./intake";
import { ActivationWorker } from "./worker";
import type { StellarRail, Submission } from "./stellar-rail";
import type { ActivationFlags } from "../../lib/activation-flags";

// Business credits (BUSINESS_CREDITS=on): an activation draws one prepaid credit, yearly first, and 1.1 XLM of funding.
let pg: PGlite;
let clock = new Date();
const flags: ActivationFlags = { enabled: true, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: 11_000_000n, globalDailyCap: 1000, userDailyCap: 3, businessCredits: true };
const partner = { tenantId: 1, tenantName: "LMS", apiKeyId: 1, signingKeyId: 1, dailyCap: 50, allowDebt: false };
const deps = (over: Partial<IntakeDeps> = {}): IntakeDeps => ({ db: state.db, flags, now: () => clock, paused: () => false, custodyAllowed: () => true, frozen: async () => false, ...over });
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const pots = async () => (await q("SELECT annual_credits AS annual, monthly_credits AS monthly, funding_xlm::text AS funding FROM tenant_credit_balances WHERE tenant_id=1"))[0];
const fails = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return `${(e as any).code}:${(e as any).status}`; } };
const body = (over: Record<string, unknown> = {}) => validBody({ completedAt: new Date(clock.getTime() - 60_000).toISOString(), ...over });

async function setCredits(annual: number, monthly: number, funding: string) {
  await pg.exec("TRUNCATE tenant_credit_balances, credit_ledger");
  await pg.query("INSERT INTO tenant_credit_balances (tenant_id, annual_credits, monthly_credits, funding_xlm) VALUES (1,$1,$2,$3)", [annual, monthly, funding]);
}
async function addUser2() {
  await pg.query("INSERT INTO tenant_users (tenant_id, user_id) VALUES (1,2)");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (2,'stellar','testnet',$1,'w',true,0)", [ADDRESS_2]);
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (2,'phrase',$1,'local','custody')", ["s".repeat(60)]);
}

class FakeRail implements StellarRail {
  treasuryAddress = "GTREASURY";
  existing = new Set<string>();
  plan: (Submission | "land")[] = [];
  landed = new Set<string>();
  private n = 0;
  async treasuryStroops() { return 100_000_000_000n; }
  async account(a: string) { return { exists: this.existing.has(a), stroops: 0n }; }
  async build(_d: string, _s: bigint, nowSeconds: number) { const hash = `h${++this.n}`; return { hash, envelope: `env:${hash}`, maxTime: nowSeconds + 120 }; }
  async submit(envelope: string): Promise<Submission> {
    const step = this.plan.shift() ?? "land";
    if (step === "land") { this.landed.add(envelope.slice(4)); return { accepted: true }; }
    return step;
  }
  async lookup(hash: string) { return this.landed.has(hash) ? "success" as const : "missing" as const; }
  async ledgerClosedAt() { return Math.floor(clock.getTime() / 1000); }
}

beforeAll(async () => {
  pg = await activationDatabase();
  await pg.transaction((tx) => applyCreditsV1(connectionOf(tx)));
  state.db = drizzle(pg);
}, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => { clock = new Date(); await seedActivation(pg, { balance: "0", feeXlm: "2" }); await setCredits(1, 2, "3.3"); });

describe("activation with business credits", () => {
  it("draws a yearly credit first and 1.1 XLM of funding, and leaves prepaid_xlm_balance alone", async () => {
    expect((await submitActivation(deps(), partner, body())).status).toBe(202);
    expect(await pots()).toEqual({ annual: 0, monthly: 2, funding: "2.2000000" });
    const wallet = (await q("SELECT credit_plan, management_paid_until, billing_event_id FROM wallet_activations"))[0];
    expect(wallet.credit_plan).toBe("annual");
    expect(new Date(wallet.management_paid_until).getUTCFullYear()).toBe(clock.getUTCFullYear() + 1);
    expect(wallet.billing_event_id).toBeNull();
    expect((await q("SELECT count(*)::int AS n FROM billing_events"))[0].n).toBe(0);
    expect((await q("SELECT prepaid_xlm_balance::text AS b FROM tenants WHERE id=1"))[0].b).toBe("0.0000000");
    expect(await q("SELECT event, plan, annual_credits_delta AS a, monthly_credits_delta AS m, funding_delta_xlm::text AS f FROM credit_ledger"))
      .toEqual([{ event: "activation_draw", plan: "annual", a: -1, m: 0, f: "-1.1000000" }]);
    expect((await q("SELECT detail FROM audit_logs WHERE action='activation_requested'"))[0].detail).toMatchObject({ credits: ["annual"] });
  });

  it("then uses monthly credits, with no paid-until date", async () => {
    await setCredits(0, 2, "2.2");
    await submitActivation(deps(), partner, body());
    expect((await q("SELECT credit_plan, management_paid_until FROM wallet_activations"))[0]).toEqual({ credit_plan: "monthly", management_paid_until: null });
    expect(await pots()).toEqual({ annual: 0, monthly: 1, funding: "1.1000000" });
  });

  it("refuses with 402 and changes nothing when no credit is left", async () => {
    await setCredits(0, 0, "10");
    expect(await fails(submitActivation(deps(), partner, body()))).toBe("BUDGET_EXHAUSTED:402");
    expect((await q("SELECT count(*)::int AS n FROM wallet_activations"))[0].n).toBe(0);
    expect(await pots()).toEqual({ annual: 0, monthly: 0, funding: "10.0000000" });
  });

  it("refuses with 402 when the funding pot can't cover 1.1 XLM", async () => {
    await setCredits(0, 5, "1.0999999");
    expect(await fails(submitActivation(deps(), partner, body()))).toBe("BUDGET_EXHAUSTED:402");
  });

  it("refuses with 402 for a business with no credit row at all", async () => {
    await pg.exec("TRUNCATE tenant_credit_balances");
    expect(await fails(submitActivation(deps(), partner, body()))).toBe("BUDGET_EXHAUSTED:402");
  });

  it("a repeat call with the same keys draws nothing more", async () => {
    await submitActivation(deps(), partner, body());
    expect((await submitActivation(deps(), partner, body())).status).toBe(200);
    expect(await pots()).toEqual({ annual: 0, monthly: 2, funding: "2.2000000" });
    expect((await q("SELECT count(*)::int AS n FROM credit_ledger"))[0].n).toBe(1);
  });

  it("two learners use the yearly credit, then a monthly one", async () => {
    await addUser2();
    await submitActivation(deps(), partner, body());
    await submitActivation(deps(), partner, body({ ammaUserId: 2, completionId: "completion-0002", idempotencyKey: "idem-key-0002" }));
    expect((await q("SELECT address, credit_plan FROM wallet_activations ORDER BY id"))).toEqual([{ address: ADDRESS, credit_plan: "annual" }, { address: ADDRESS_2, credit_plan: "monthly" }]);
    expect(await pots()).toEqual({ annual: 0, monthly: 1, funding: "1.1000000" });
  });

  it("with the switch off, the old 3.1 debit path is unchanged", async () => {
    await pg.exec("UPDATE tenants SET prepaid_xlm_balance = 10 WHERE id = 1");
    await submitActivation(deps({ flags: { ...flags, businessCredits: false } }), partner, body());
    expect((await q("SELECT prepaid_xlm_balance::text AS b FROM tenants WHERE id=1"))[0].b).toBe("6.9000000");
    expect(await pots()).toEqual({ annual: 1, monthly: 2, funding: "3.3000000" });
    expect((await q("SELECT credit_plan FROM wallet_activations"))[0].credit_plan).toBeNull();
  });
});

describe("worker with business credits", () => {
  const worker = (rail: StellarRail) => new ActivationWorker({ db: state.db, rail, flags, paused: () => false, sessionLock: async () => async () => undefined, now: () => clock });

  it("keeps the credit drawn once the wallet is funded", async () => {
    await submitActivation(deps(), partner, body());
    expect(await worker(new FakeRail()).tick()).toMatchObject({ confirmed: 1 });
    expect(await pots()).toEqual({ annual: 0, monthly: 2, funding: "2.2000000" });
  });

  it("returns the credit and its 1.1 XLM exactly once when the account already exists", async () => {
    await submitActivation(deps(), partner, body());
    const rail = new FakeRail(); rail.existing.add(ADDRESS);
    await worker(rail).tick(); await worker(rail).tick();
    expect((await q("SELECT state FROM wallet_activations"))[0].state).toBe("skipped_already_active");
    expect(await pots()).toEqual({ annual: 1, monthly: 2, funding: "3.3000000" });
    expect((await q("SELECT event FROM credit_ledger ORDER BY id")).map((r) => r.event)).toEqual(["activation_draw", "activation_refund"]);
    expect((await q("SELECT detail FROM audit_logs WHERE action='activation_refunded'"))[0].detail).toMatchObject({ creditReturned: "annual" });
  });

  it("returns the credit once when all three attempts fail, and marks the row refunded", async () => {
    await submitActivation(deps(), partner, body());
    const rail = new FakeRail();
    rail.plan = [{ accepted: false, code: "bad-seq" }, { accepted: false, code: "fee" }, { accepted: false, code: "rejected" }];
    for (const wait of [0, 61, 320]) { clock = new Date(clock.getTime() + wait * 1000); await worker(rail).tick(); }
    expect((await q("SELECT state, attempts FROM wallet_activations"))[0]).toEqual({ state: "refunded", attempts: 3 });
    expect(await pots()).toEqual({ annual: 1, monthly: 2, funding: "3.3000000" });
    clock = new Date(clock.getTime() + 10_000_000); await worker(rail).tick();
    expect((await q("SELECT count(*)::int AS n FROM credit_ledger WHERE event='activation_refund'"))[0].n).toBe(1);
  });
});
