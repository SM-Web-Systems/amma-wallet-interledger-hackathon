import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { activationDatabase, connectionOf } from "../db/migrations/activation.test-support";
import { applyCreditsV1 } from "../db/migrations/credits-v1";
import { applyBusinessControlsV1 } from "../db/migrations/business-controls-v1";
import { ADDRESS_2, seedActivation, validBody } from "../modules/activation/activation.test-support";
import { setAppLogger } from "../lib/app-log";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));

import { submitActivation } from "../modules/activation/intake";
import type { ActivationFlags } from "../lib/activation-flags";
import { checkFloors, controlsView, floorHoldActive, forgetControlsPresent, GRACE_DAYS, pauseActivations, readFloor, resumeActivations, setDailyCap } from "./business-controls";

let pg: PGlite;
let clock = new Date("2026-11-18T08:00:00Z");
const DAY = 86_400_000;
const flags: ActivationFlags = { enabled: true, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: 11_000_000n, globalDailyCap: 1000, userDailyCap: 3, businessCredits: true };
const partner = { tenantId: 1, tenantName: "LMS", apiKeyId: 1, signingKeyId: 1, dailyCap: 50, allowDebt: false };
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
let mails: { to: string; subject: string }[] = [];
let mailWorks = true;
const deps = () => ({ mail: async (to: string, subject: string) => { if (!mailWorks) return false; mails.push({ to, subject }); return true; }, ownerEmail: "owner@example.test", now: clock });
const intake = (n = 1) => submitActivation({ db: state.db, flags, now: () => clock, paused: () => false, custodyAllowed: () => true, frozen: async () => false }, partner,
  validBody({ completionId: `completion-${n}-000`, idempotencyKey: `idem-key-${n}-000`, completedAt: new Date(clock.getTime() - 60_000).toISOString() }));
const fails = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return `${(e as any).code}:${(e as any).status}`; } };
const setPot = (management: string, monthly = 50) => pg.query("UPDATE tenant_credit_balances SET management_xlm = $1, monthly_credits = $2", [management, monthly]);
const controls = async () => (await q("SELECT paused_at IS NOT NULL AS paused, below_floor_since IS NOT NULL AS below, floor_hold_since IS NOT NULL AS held, floor_xlm::text AS floor FROM business_activation_controls"))[0];
const alerts = async () => (await q("SELECT kind, delivered, sent_to FROM business_alerts ORDER BY id")).map((a) => `${a.kind}:${a.delivered}`);

/** One confirmed monthly-plan wallet: the floor is then 2 months x 0.1 = 0.2 XLM. */
async function oneLiveWallet() {
  await pg.exec("UPDATE tenant_credit_balances SET monthly_credits = 50, funding_xlm = 55");
  expect((await intake()).status).toBe(202);
  await pg.query("UPDATE wallet_activations SET state = 'confirmed', confirmed_at = $1, tx_hash = $2", [clock.toISOString(), "a".repeat(64)]);
}

beforeAll(async () => {
  pg = await activationDatabase();
  for (const a of [applyCreditsV1, applyBusinessControlsV1]) await pg.transaction((tx) => a(connectionOf(tx)));
  state.db = drizzle(pg);
  forgetControlsPresent();
}, 60_000);
afterAll(async () => { await pg?.close(); setAppLogger(null); });
beforeEach(async () => {
  clock = new Date("2026-11-18T08:00:00Z"); mails = []; mailWorks = true;
  setAppLogger({ info: () => {}, warn: () => {}, error: () => {} });
  await seedActivation(pg);
  await pg.exec("TRUNCATE tenant_credit_balances, credit_ledger, business_activation_controls, business_alerts");
  await pg.exec("UPDATE tenants SET contact_email = 'lms@example.test' WHERE id = 1; INSERT INTO tenant_credit_balances (tenant_id, monthly_credits, funding_xlm, management_xlm) VALUES (1, 50, 55, 15)");
  await pg.exec("INSERT INTO credit_ledger (tenant_id, event, plan, monthly_credits_delta, funding_delta_xlm, idempotency_key, created_by) VALUES (1, 'bundle_credit', 'monthly', 50, 55, 'deposit:1', 't')");
});

describe("the balance floor", () => {
  it("reads the floor from live wallets: one monthly wallet is 0.2 XLM for the next 2 months", async () => {
    await oneLiveWallet();
    expect(await readFloor(state.db, 1, clock)).toMatchObject({ floor: "0.2000000", below: false, creditsLeft: 49 });
  });

  it("warns once below the floor, stops new activations after 7 days, and a top-up lifts it at once", async () => {
    await oneLiveWallet();
    await setPot("0.1");
    expect(await checkFloors(state.db, deps())).toMatchObject({ warned: 1, held: 0 });
    expect(await controls()).toMatchObject({ below: true, held: false, floor: "0.2000000" });
    expect(mails.map((m) => m.to)).toEqual(["lms@example.test", "owner@example.test"]);
    expect(mails[0].subject).toContain("below its balance floor");
    // Still within the grace: no second warning, and activations go on.
    clock = new Date(clock.getTime() + 3 * DAY);
    expect(await checkFloors(state.db, deps())).toMatchObject({ warned: 0, held: 0 });
    // After 7 days: held, both told, the hold audited, new credit activations refused.
    clock = new Date(clock.getTime() + (GRACE_DAYS - 3) * DAY);
    expect(await checkFloors(state.db, deps())).toMatchObject({ held: 1 });
    expect(await controls()).toMatchObject({ held: true });
    expect((await q("SELECT action FROM audit_logs WHERE action = 'business_floor_hold'"))).toHaveLength(1);
    // A second learner.
    await pg.query("INSERT INTO tenant_users (tenant_id, user_id) VALUES (1,2)");
    await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (2,'stellar','testnet',$1,'w',true,0)", [ADDRESS_2]);
    await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (2,'phrase',$1,'local','custody')", ["s".repeat(60)]);
    const second = () => submitActivation({ db: state.db, flags, now: () => clock, paused: () => false, custodyAllowed: () => true, frozen: async () => false }, partner,
      validBody({ ammaUserId: 2, completionId: "completion-two-0", idempotencyKey: "idem-key-two-0", completedAt: new Date(clock.getTime() - 60_000).toISOString() }));
    expect(await fails(second())).toBe("BALANCE_BELOW_FLOOR:402");
    expect((await q("SELECT count(*)::int AS n FROM wallet_activations"))[0].n).toBe(1);
    // A top-up: the very next call goes through, before any check runs.
    await setPot("5");
    expect(await fails(second())).toBe("ok");
    // The next check clears the hold and says so.
    mails = [];
    expect(await checkFloors(state.db, deps())).toMatchObject({ cleared: 1 });
    expect(await controls()).toMatchObject({ below: false, held: false });
    expect(mails[0].subject).toContain("back above");
    expect(await alerts()).toEqual(["floor_warning:true", "floor_hold:true", "floor_cleared:true"]);
  });

  it("a warning that couldn't be emailed is sent again on the next check, and only then", async () => {
    await oneLiveWallet();
    await setPot("0.1");
    mailWorks = false;
    await checkFloors(state.db, deps());
    mailWorks = true;
    clock = new Date(clock.getTime() + 3_600_000);
    expect(await checkFloors(state.db, deps())).toMatchObject({ warned: 1 });
    expect(await checkFloors(state.db, deps())).toMatchObject({ warned: 0 });
    expect(await alerts()).toEqual(["floor_warning:false", "floor_warning:true"]);
  });

  it("a business with no live wallets has a zero floor and is never below it", async () => {
    await setPot("0");
    expect(await checkFloors(state.db, deps())).toMatchObject({ tenants: 1, warned: 0 });
    expect(await controls()).toMatchObject({ below: false, floor: "0.0000000" });
  });

  it("low balance (few credits, or close to the floor) is emailed at most once a week, and only to a business that bought a bundle", async () => {
    await setPot("15", 4);
    expect(await checkFloors(state.db, deps())).toMatchObject({ lowBalance: 1 });
    expect(mails[0].subject).toContain("running low");
    clock = new Date(clock.getTime() + 2 * DAY);
    expect(await checkFloors(state.db, deps())).toMatchObject({ lowBalance: 0 });
    clock = new Date(clock.getTime() + 6 * DAY);
    expect(await checkFloors(state.db, deps())).toMatchObject({ lowBalance: 1 });
    await pg.exec("DELETE FROM credit_ledger; DELETE FROM business_alerts");
    expect(await checkFloors(state.db, deps())).toMatchObject({ lowBalance: 0 });
  });

  it("a hold is lifted by the live pot only when it's back at the floor", () => {
    const held = { pausedAt: null, pausedBy: null, floor: "0.2", management: "0.1", checkedAt: null, belowSince: "x", holdSince: "x" };
    expect(floorHoldActive(held, "0.1")).toBe(true);
    expect(floorHoldActive(held, "0.2")).toBe(false);
    expect(floorHoldActive({ ...held, holdSince: null }, "0")).toBe(false);
    expect(floorHoldActive(null, "0")).toBe(false);
  });
});

describe("pause, resume and the daily cap", () => {
  it("a paused business gets BUSINESS_PAUSED and nothing is drawn; resume lets activations through again; both are emailed and audited", async () => {
    expect(await pauseActivations(state.db, deps(), { tenantId: 1, by: "api-key:1" })).toEqual({ changed: true });
    expect(await pauseActivations(state.db, deps(), { tenantId: 1, by: "api-key:1" })).toEqual({ changed: false });
    expect(await fails(intake())).toBe("BUSINESS_PAUSED:423");
    expect((await q("SELECT monthly_credits FROM tenant_credit_balances"))[0].monthly_credits).toBe(50);
    expect(await resumeActivations(state.db, deps(), { tenantId: 1, by: "owner" })).toEqual({ changed: true });
    expect(await fails(intake())).toBe("ok");
    expect(mails.map((m) => m.subject)).toEqual([expect.stringContaining("paused"), expect.stringContaining("paused"), expect.stringContaining("resumed"), expect.stringContaining("resumed")]);
    expect((await q("SELECT action FROM audit_logs WHERE action LIKE 'business_activations_%' ORDER BY id")).map((a) => a.action)).toEqual(["business_activations_paused", "business_activations_resumed"]);
    expect(await alerts()).toEqual(["paused:true", "resumed:true"]);
  });

  it("a replayed request still returns its original answer while paused", async () => {
    expect((await intake()).status).toBe(202);
    await pauseActivations(state.db, deps(), { tenantId: 1, by: "owner" });
    expect((await intake()).status).toBe(200);
  });

  it("changes the daily cap within 0 to 1000, audited and listed, and refuses anything else", async () => {
    expect(await setDailyCap(state.db, { now: clock }, { tenantId: 1, dailyCap: 10, by: "api-key:1" })).toEqual({ before: 50, after: 10 });
    expect((await q("SELECT daily_cap, updated_by FROM partner_activation_settings"))[0]).toEqual({ daily_cap: 10, updated_by: "api-key:1" });
    await expect(setDailyCap(state.db, { now: clock }, { tenantId: 1, dailyCap: 1001, by: "x" })).rejects.toThrow("0 to 1000");
    await expect(setDailyCap(state.db, { now: clock }, { tenantId: 1, dailyCap: 2.5, by: "x" })).rejects.toThrow("whole number");
    await expect(setDailyCap(state.db, { now: clock }, { tenantId: 2, dailyCap: 5, by: "x" })).rejects.toThrow("isn't set up");
    const view = await controlsView(state.db, 1);
    expect(view).toMatchObject({ paused: false, dailyCap: 10, alerts: [{ kind: "daily_cap_changed", detail: { before: 50, after: 10 } }] });
    expect((await q("SELECT action FROM audit_logs WHERE action = 'business_daily_cap_changed'"))).toHaveLength(1);
  });
});
