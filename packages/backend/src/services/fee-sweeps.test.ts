import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { activationDatabase, connectionOf } from "../db/migrations/activation.test-support";
import { applyCreditsV1 } from "../db/migrations/credits-v1";
import { applyBusinessWalletsV1 } from "../db/migrations/business-wallets-v1";
import { applyBusinessDepositsV1 } from "../db/migrations/business-deposits-v1";
import { applyFeeSweepsV1 } from "../db/migrations/fee-sweeps-v1";
import { setAppLogger } from "../lib/app-log";
vi.mock("../db", () => ({ db: {}, schema: {} }));
import { FEE_FLOAT_STROOPS, FeeSweeper, MAX_SWEEP_ATTEMPTS, sweepable } from "./fee-sweeps";
import type { StellarRail, Submission } from "../modules/activation/stellar-rail";

let pg: PGlite;
let db: any;
let clock = new Date("2026-11-18T08:00:00Z");
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const WALLET = Keypair.random().publicKey();
const FEE = Keypair.random().publicKey();
const logs: string[] = [];
const XLM = 10_000_000n;

const landed = new Set<string>();
class FakeRail implements StellarRail {
  readonly treasuryAddress = WALLET;
  existing = new Set<string>([FEE]);
  plan: (Submission | Error | "land")[] = [];
  sent: { to: string; stroops: bigint; create: boolean }[] = [];
  private n = 0;
  constructor(public stroops = 1000n * XLM) {}
  async treasuryStroops() { return this.stroops; }
  async account(a: string) { return { exists: this.existing.has(a), stroops: 0n }; }
  async build(): Promise<never> { throw new Error("not for sweeps"); }
  async buildPayment(to: string, stroops: bigint, nowSeconds: number, create: boolean) {
    this.sent.push({ to, stroops, create });
    const hash = (++this.n).toString(16).padStart(64, "0");
    return { hash, envelope: `env:${hash}`, maxTime: nowSeconds + 120 };
  }
  async submit(envelope: string): Promise<Submission> {
    const step = this.plan.shift() ?? "land";
    if (step instanceof Error) throw step;
    if (step === "land") { landed.add(envelope.slice(4)); return { accepted: true }; }
    return step;
  }
  async lookup(hash: string) { return landed.has(hash) ? "success" as const : "missing" as const; }
  async ledgerClosedAt() { return Math.floor(clock.getTime() / 1000); }
}
const sweeper = (rail: StellarRail | null) => new FeeSweeper({ db, network: "testnet", railFor: async () => rail, lookup: rail ?? new FakeRail(), now: () => clock });

async function deposit(fee: string, op = "9001") {
  await pg.query(`INSERT INTO credit_ledger (id, tenant_id, event, plan, monthly_credits_delta, funding_delta_xlm, idempotency_key, created_by) VALUES ($1::bigint, 1, 'bundle_credit', 'monthly', 100, 110, $2, 't')`, [op, `deposit:testnet:${op}`]);
  await pg.query(`INSERT INTO business_deposits (tenant_id, network, wallet_address, operation_id, tx_hash, from_address, amount_xlm, received_at, state, bundle_slug, plan, users, funding_xlm, fee_due_xlm, credit_ledger_id)
    VALUES (1, 'testnet', $1, $2, $3, $4, 341, now(), 'credited', 'monthly-100', 'monthly', 100, 110, $5::numeric, $6::bigint)`, [WALLET, op, "b".repeat(64), Keypair.random().publicKey(), fee, op]);
}

beforeAll(async () => {
  pg = await activationDatabase();
  for (const a of [applyCreditsV1, applyBusinessWalletsV1, applyBusinessDepositsV1, applyFeeSweepsV1]) await pg.transaction((tx) => a(connectionOf(tx)));
  db = drizzle(pg);
}, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  clock = new Date("2026-11-18T08:00:00Z"); logs.length = 0; landed.clear();
  setAppLogger({ info: () => {}, warn: (_o, m) => logs.push(m), error: (_o, m) => logs.push(m) });
  await pg.exec(`TRUNCATE tenants, audit_logs RESTART IDENTITY CASCADE; INSERT INTO tenants (id, slug, name) VALUES (1,'lms','LMS')`);
  await pg.query("INSERT INTO business_wallets (tenant_id, network, address, sealed_secret, provider, created_by, created_at) VALUES (1,'testnet',$1,$2,'local','t', now() - interval '1 day')", [WALLET, "x".repeat(60)]);
  await pg.query("INSERT INTO fee_address_pool (network, address, added_by, tenant_id, assigned_at) VALUES ('testnet',$1,'owner',1,now())", [FEE]);
  await pg.exec("INSERT INTO tenant_credit_balances (tenant_id, monthly_credits, funding_xlm, management_xlm) VALUES (1, 100, 110, 30)");
});
afterEach(() => setAppLogger(null));

describe("fee sweeps", () => {
  it("pays a deposit's fee share to the business's hardware address once, with a ledger row and an audit", async () => {
    await deposit("200");
    const rail = new FakeRail();
    expect(await sweeper(rail).tick()).toMatchObject({ queued: 1, confirmed: 1 });
    expect(rail.sent).toEqual([{ to: FEE, stroops: 200n * XLM, create: false }]);
    expect((await q("SELECT state, from_address, to_address FROM fee_sweeps"))[0]).toEqual({ state: "confirmed", from_address: WALLET, to_address: FEE });
    expect((await q("SELECT event FROM credit_ledger WHERE event = 'fee_sweep'"))).toHaveLength(1);
    expect((await q("SELECT action FROM audit_logs"))[0].action).toBe("fee_sweep_confirmed");
    expect(await sweeper(rail).tick()).toMatchObject({ queued: 0, confirmed: 0 });
    expect(rail.sent).toHaveLength(1);
  });

  it("sweeps a monthly management charge made while the business had its wallet", async () => {
    await pg.exec("INSERT INTO credit_ledger (tenant_id, event, management_delta_xlm, fee_xlm, idempotency_key, created_by) VALUES (1, 'management_charge', -0.2, 0.2, 'management:2026-11', 'monthly-job')");
    const rail = new FakeRail();
    await sweeper(rail).tick();
    expect(rail.sent).toEqual([{ to: FEE, stroops: 2_000_000n, create: false }]);
  });

  it("creates the hardware address on the first sweep when it isn't on the ledger yet", async () => {
    await deposit("200");
    const rail = new FakeRail(); rail.existing.clear();
    await sweeper(rail).tick();
    expect(rail.sent[0].create).toBe(true);
  });

  it("an exact deposit is swept less the 0.01 XLM fee float, which stays in the wallet, and the audit says so", async () => {
    await deposit("200");
    // The wallet holds exactly the deposit: 110 funding + 30 management + 1 reserve + 200 fee = 341.
    const rail = new FakeRail(341n * XLM);
    expect(await sweeper(rail).tick()).toMatchObject({ confirmed: 1 });
    expect(rail.sent).toEqual([{ to: FEE, stroops: 200n * XLM - FEE_FLOAT_STROOPS, create: false }]);
    expect((await q("SELECT amount_xlm::text AS a FROM fee_sweeps"))[0].a).toBe("199.9900000");
    expect((await q("SELECT detail FROM audit_logs WHERE action = 'fee_sweep_confirmed'"))[0].detail).toMatchObject({ amount: "199.9900000", booked: "200.0000000", withheld: "0.0100000" });
    expect((await q("SELECT reference FROM credit_ledger WHERE event = 'fee_sweep'"))[0].reference).toContain("0.0100000 kept as fee float");
  });

  it("sends the whole fee when there's room for the float, and nothing to withhold", async () => {
    await deposit("200");
    const rail = new FakeRail(342n * XLM);
    await sweeper(rail).tick();
    expect(rail.sent[0].stroops).toBe(200n * XLM);
    expect((await q("SELECT detail FROM audit_logs WHERE action = 'fee_sweep_confirmed'"))[0].detail).toMatchObject({ amount: "200.0000000", withheld: "0.0000000" });
  });

  it("waits, never withholding more than the float, when the wallet can't keep its pots, activations and reserve", async () => {
    await deposit("200");
    const short = new FakeRail(341n * XLM - 1n); // one stroop under an exact deposit: 0.0100001 short
    expect(await sweeper(short).tick()).toMatchObject({ confirmed: 0, waiting: 1 });
    expect(short.sent).toEqual([]);
    expect(logs).toContain("fee_sweep_short");
    expect((await q("SELECT state, attempts FROM fee_sweeps"))[0]).toEqual({ state: "pending", attempts: 0 });
  });

  it("keeps deposits held for the owner out of reach: a held 5 XLM isn't swept as fee", async () => {
    await deposit("200");
    await pg.query(`INSERT INTO business_deposits (tenant_id, network, wallet_address, operation_id, tx_hash, from_address, amount_xlm, received_at, state, held_reason)
      VALUES (1, 'testnet', $1, '9100', $2, $3, 5, now(), 'held', 'no_bundle_matches_amount')`, [WALLET, "c".repeat(64), Keypair.random().publicKey()]);
    // 341 exact deposit + 5 held = 346; the held 5 must stay, so the sweep is 199.99, not 200.
    const rail = new FakeRail(346n * XLM);
    await sweeper(rail).tick();
    expect(rail.sent[0].stroops).toBe(200n * XLM - FEE_FLOAT_STROOPS);
    await pg.exec("TRUNCATE fee_sweeps, audit_logs; DELETE FROM credit_ledger WHERE event = 'fee_sweep'");
    // With the held money already spent elsewhere, the wallet is short and the sweep waits.
    const spent = new FakeRail(341n * XLM);
    expect(await sweeper(spent).tick()).toMatchObject({ waiting: 1 });
    expect(spent.sent).toEqual([]);
  });

  it("sweepable: whole fee with room, up to the float less when tight, otherwise nothing", () => {
    expect(sweepable(200n * XLM, 300n * XLM)).toBe(200n * XLM);
    expect(sweepable(200n * XLM, 200n * XLM)).toBe(200n * XLM);
    expect(sweepable(200n * XLM, 200n * XLM - FEE_FLOAT_STROOPS)).toBe(200n * XLM - FEE_FLOAT_STROOPS);
    expect(sweepable(200n * XLM, 200n * XLM - FEE_FLOAT_STROOPS - 1n)).toBeNull();
    expect(sweepable(FEE_FLOAT_STROOPS, 0n)).toBeNull();
    expect(sweepable(FEE_FLOAT_STROOPS, -5n)).toBeNull();
  });

  it("waits, without spending an attempt, when the business has no fee address or no wallet", async () => {
    await deposit("200");
    await pg.exec("DELETE FROM fee_address_pool");
    expect(await sweeper(new FakeRail()).tick()).toMatchObject({ waiting: 1 });
    expect(logs).toContain("fee_sweep_no_fee_address");
    await pg.query("INSERT INTO fee_address_pool (network, address, added_by, tenant_id, assigned_at) VALUES ('testnet',$1,'owner',1,now())", [FEE]);
    expect(await sweeper(null).tick()).toMatchObject({ waiting: 1 });
    expect((await q("SELECT attempts FROM fee_sweeps"))[0].attempts).toBe(0);
  });

  it("an unknown submit outcome is looked up, never sent again, and confirmed when it lands", async () => {
    await deposit("200");
    const rail = new FakeRail(); rail.plan = [new Error("timeout")];
    await sweeper(rail).tick();
    expect((await q("SELECT state FROM fee_sweeps"))[0].state).toBe("submitted");
    landed.add(rail.sent.length.toString(16).padStart(64, "0"));
    expect(await sweeper(rail).tick()).toMatchObject({ confirmed: 1 });
    expect(rail.sent).toHaveLength(1);
  });

  it("a refused sweep is retried after a wait and stops after the last attempt, with an audit", async () => {
    await deposit("200");
    const rail = new FakeRail(); rail.plan = Array.from({ length: MAX_SWEEP_ATTEMPTS }, () => ({ accepted: false, code: "rejected" }));
    for (let i = 0; i < MAX_SWEEP_ATTEMPTS; i++) { await sweeper(rail).tick(); clock = new Date(clock.getTime() + 121_000); }
    expect((await q("SELECT state, attempts FROM fee_sweeps"))[0]).toEqual({ state: "failed", attempts: MAX_SWEEP_ATTEMPTS });
    expect((await q("SELECT action FROM audit_logs WHERE action = 'fee_sweep_failed'"))).toHaveLength(1);
    await sweeper(rail).tick();
    expect(rail.sent).toHaveLength(MAX_SWEEP_ATTEMPTS);
  });

  it("an expired sweep is rebuilt only after every earlier hash is checked", async () => {
    await deposit("200");
    const rail = new FakeRail(); rail.plan = [new Error("timeout")];
    await sweeper(rail).tick();
    clock = new Date(clock.getTime() + 200_000);
    await sweeper(rail).tick(); // past the deadline: back to pending
    clock = new Date(clock.getTime() + 121_000);
    expect(await sweeper(rail).tick()).toMatchObject({ confirmed: 1 });
    expect(rail.sent).toHaveLength(2);
    expect((await q("SELECT array_length(tx_hashes, 1) AS n FROM fee_sweeps"))[0].n).toBe(2);
  });
});
