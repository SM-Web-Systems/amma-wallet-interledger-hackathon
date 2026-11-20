import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { activationDatabase, connectionOf } from "../../db/migrations/activation.test-support";
import { applyCreditsV1 } from "../../db/migrations/credits-v1";
import { applyBusinessWalletsV1 } from "../../db/migrations/business-wallets-v1";
import { ADDRESS, ADDRESS_2, seedActivation, validBody } from "./activation.test-support";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../../db", async () => ({ get db() { return state.db; }, schema: await import("../../db/schema") }));
vi.mock("../../lib/mailer", () => ({ sendEmail: vi.fn() }));

import { submitActivation, type IntakeDeps } from "./intake";
import { ActivationWorker } from "./worker";
import type { StellarRail, Submission } from "./stellar-rail";
import type { ActivationFlags } from "../../lib/activation-flags";
import { setAppLogger } from "../../lib/app-log";

// BUSINESS_WALLETS=on: a credit activation is paid from the business's own wallet, everything else from the shared treasury.
let pg: PGlite;
let clock = new Date();
const flags: ActivationFlags = { enabled: true, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: 11_000_000n, globalDailyCap: 1000, userDailyCap: 3, businessCredits: true, businessWallets: true };
const partner = { tenantId: 1, tenantName: "LMS", apiKeyId: 1, signingKeyId: 1, dailyCap: 50, allowDebt: false };
const deps = (over: Partial<IntakeDeps> = {}): IntakeDeps => ({ db: state.db, flags, now: () => clock, paused: () => false, custodyAllowed: () => true, frozen: async () => false, ...over });
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const body = (over: Record<string, unknown> = {}) => validBody({ completedAt: new Date(clock.getTime() - 60_000).toISOString(), ...over });
const logs: string[] = [];

const landed = new Set<string>();
class FakeRail implements StellarRail {
  built: string[] = [];
  private n = 0;
  constructor(readonly treasuryAddress: string, public stroops = 100_000_000_000n) {}
  async treasuryStroops() { return this.stroops; }
  async account() { return { exists: false, stroops: 0n }; }
  async build(destination: string, _s: bigint, nowSeconds: number) { this.built.push(destination); const hash = `${this.treasuryAddress}-${++this.n}`; return { hash, envelope: `env:${hash}`, maxTime: nowSeconds + 120 }; }
  async submit(envelope: string): Promise<Submission> { landed.add(envelope.slice(4)); return { accepted: true }; }
  async lookup(hash: string) { return landed.has(hash) ? "success" as const : "missing" as const; }
  async ledgerClosedAt() { return Math.floor(clock.getTime() / 1000); }
}
const TREASURY = "GTREASURY";
const LMS_WALLET = "GLMSWALLET";

async function setCredits(annual: number, monthly: number, funding: string) {
  await pg.exec("TRUNCATE tenant_credit_balances, credit_ledger");
  await pg.query("INSERT INTO tenant_credit_balances (tenant_id, annual_credits, monthly_credits, funding_xlm) VALUES (1,$1,$2,$3)", [annual, monthly, funding]);
}
async function addUser2() {
  await pg.query("INSERT INTO tenant_users (tenant_id, user_id) VALUES (1,2)");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (2,'stellar','testnet',$1,'w',true,0)", [ADDRESS_2]);
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (2,'phrase',$1,'local','custody')", ["s".repeat(60)]);
}
const worker = (treasury: StellarRail, businessRail?: (tenantId: number) => Promise<StellarRail | null>) =>
  new ActivationWorker({ db: state.db, rail: treasury, businessRail, flags, paused: () => false, sessionLock: async () => async () => undefined, now: () => clock });

beforeAll(async () => {
  pg = await activationDatabase();
  await pg.transaction((tx) => applyCreditsV1(connectionOf(tx)));
  await pg.transaction((tx) => applyBusinessWalletsV1(connectionOf(tx)));
  state.db = drizzle(pg);
}, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => {
  clock = new Date(); logs.length = 0; landed.clear();
  setAppLogger({ info: () => {}, warn: (_o, msg) => logs.push(msg), error: (_o, msg) => logs.push(msg) });
  await seedActivation(pg, { balance: "10", feeXlm: "2" });
  await setCredits(1, 2, "3.3");
});
afterEach(() => setAppLogger(null));

describe("worker with business wallets", () => {
  it("pays a credit activation from the business's own wallet and records which wallet paid", async () => {
    await submitActivation(deps(), partner, body());
    const treasury = new FakeRail(TREASURY), lms = new FakeRail(LMS_WALLET);
    const asked: number[] = [];
    expect(await worker(treasury, async (t) => { asked.push(t); return lms; }).tick()).toMatchObject({ confirmed: 1 });
    expect(lms.built).toEqual([ADDRESS]);
    expect(treasury.built).toEqual([]);
    expect(asked).toEqual([1]);
    expect((await q("SELECT state, source_address FROM wallet_activations"))[0]).toEqual({ state: "confirmed", source_address: LMS_WALLET });
  });

  it("leaves the business's rows untouched when it has no wallet yet, and never falls back to the treasury", async () => {
    await submitActivation(deps(), partner, body());
    const treasury = new FakeRail(TREASURY);
    await worker(treasury, async () => null).tick();
    expect(treasury.built).toEqual([]);
    expect((await q("SELECT state, attempts FROM wallet_activations"))[0]).toEqual({ state: "reserved", attempts: 0 });
    expect(logs).toContain("activation_business_wallet_missing");
  });

  it("leaves the rows untouched when the business wallet can't cover two grants, or can't be opened", async () => {
    await submitActivation(deps(), partner, body());
    const treasury = new FakeRail(TREASURY), low = new FakeRail(LMS_WALLET, 21_999_999n);
    await worker(treasury, async () => low).tick();
    expect(low.built).toEqual([]);
    expect(logs).toContain("activation_business_wallet_refused");
    await worker(treasury, async () => { throw new Error("cannot be opened"); }).tick();
    expect(logs).toContain("activation_business_wallet_unavailable");
    expect((await q("SELECT state, attempts FROM wallet_activations"))[0]).toEqual({ state: "reserved", attempts: 0 });
  });

  it("an activation paid the old way still goes from the treasury while a business row waits", async () => {
    await addUser2();
    await submitActivation(deps({ flags: { ...flags, businessCredits: false, businessWallets: false } }), partner, body());
    await submitActivation(deps(), partner, body({ ammaUserId: 2, completionId: "completion-0002", idempotencyKey: "idem-key-0002" }));
    const treasury = new FakeRail(TREASURY);
    expect(await worker(treasury, async () => null).tick()).toMatchObject({ confirmed: 1 });
    expect(treasury.built).toEqual([ADDRESS]);
    expect(await q("SELECT address, state, source_address FROM wallet_activations ORDER BY id")).toEqual([
      { address: ADDRESS, state: "confirmed", source_address: TREASURY },
      { address: ADDRESS_2, state: "reserved", source_address: null },
    ]);
  });

  it("a low treasury does not hold up business wallets", async () => {
    await submitActivation(deps(), partner, body());
    const treasury = new FakeRail(TREASURY, 0n), lms = new FakeRail(LMS_WALLET);
    expect(await worker(treasury, async () => lms).tick()).toMatchObject({ confirmed: 1 });
    expect(lms.built).toEqual([ADDRESS]);
  });

  it("with business wallets off, credit activations still come from the treasury", async () => {
    await submitActivation(deps(), partner, body());
    const treasury = new FakeRail(TREASURY);
    const off = new ActivationWorker({ db: state.db, rail: treasury, flags: { ...flags, businessWallets: false }, paused: () => false, sessionLock: async () => async () => undefined, now: () => clock });
    expect(await off.tick()).toMatchObject({ confirmed: 1 });
    expect(treasury.built).toEqual([ADDRESS]);
    expect((await q("SELECT source_address FROM wallet_activations"))[0].source_address).toBeNull();
  });
});
