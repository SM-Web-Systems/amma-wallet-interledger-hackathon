import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { activationDatabase } from "../../db/migrations/activation.test-support";
import { ADDRESS, seedActivation, validBody } from "./activation.test-support";
import { setAppLogger } from "../../lib/app-log";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../../db", async () => ({ get db() { return state.db; }, schema: await import("../../db/schema") }));
vi.mock("../../lib/mailer", () => ({ sendEmail: vi.fn() }));

import { submitActivation } from "./intake";
import { ActivationWorker, codeOf, postgresSessionLock } from "./worker";
import { horizonRail, type StellarRail, type Submission } from "./stellar-rail";
import type { ActivationFlags } from "../../lib/activation-flags";

let pg: PGlite;
let clock = new Date("2026-11-16T12:00:00Z");
const flags: ActivationFlags = { enabled: true, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: 11_000_000n, globalDailyCap: 1000, userDailyCap: 3 };
const partner = { tenantId: 1, tenantName: "LMS", apiKeyId: 1, signingKeyId: 1, dailyCap: 50, allowDebt: false };
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const row = async () => (await q("SELECT * FROM wallet_activations ORDER BY id"))[0];
const balance = async () => (await q("SELECT prepaid_xlm_balance AS b FROM tenants WHERE id=1"))[0].b as string;
const events = async () => (await q("SELECT event_type, amount_xlm FROM billing_events ORDER BY id")).map((e) => [e.event_type, e.amount_xlm]);
const audits = async () => (await q("SELECT action, detail FROM audit_logs ORDER BY id")).map((a) => a.action);
const advance = (s: number) => { clock = new Date(clock.getTime() + s * 1000); };

class FakeRail implements StellarRail {
  treasuryAddress = "GTREASURY";
  treasury = 100_000_000_000n;
  existing = new Set<string>();
  ledger = new Map<string, "success" | "failed">();
  submitPlan: (Submission | Error | "land")[] = [];
  accountError?: Error; buildError?: Error;
  built: { hash: string; destination: string; stroops: bigint }[] = [];
  submitted: string[] = [];
  onSubmit?: () => Promise<void>;
  private n = 0;
  async treasuryStroops() { return this.treasury; }
  async account(a: string) { if (this.accountError) throw this.accountError; return { exists: this.existing.has(a), stroops: 0n }; }
  async build(destination: string, stroops: bigint, nowSeconds: number) {
    if (this.buildError) throw this.buildError;
    const hash = `hash${++this.n}`;
    this.built.push({ hash, destination, stroops });
    return { hash, envelope: `env:${hash}`, maxTime: nowSeconds + 120 };
  }
  async submit(envelope: string): Promise<Submission> {
    const hash = envelope.slice(4);
    this.submitted.push(hash);
    await this.onSubmit?.();
    const step = this.submitPlan.shift() ?? "land";
    if (step instanceof Error) throw step;
    if (step === "land") { this.ledger.set(hash, "success"); return { accepted: true }; }
    return step;
  }
  async lookup(hash: string) { if (this.lookupFails.has(hash)) throw Object.assign(new Error("down"), { response: { status: 503 } }); return this.ledger.get(hash) ?? "missing"; }
  ledgerAt?: number; ledgerError?: Error; lookupFails = new Set<string>();
  async ledgerClosedAt() { if (this.ledgerError) throw this.ledgerError; return this.ledgerAt ?? Math.floor(clock.getTime() / 1000); }
}
let rail: FakeRail;
let paused = false;
const noLock = async () => async () => undefined;
const worker = (over: Partial<ConstructorParameters<typeof ActivationWorker>[0]> = {}) => new ActivationWorker({ db: state.db, rail, flags, paused: () => paused, sessionLock: noLock, now: () => clock, ...over });
const reserve = async (body = validBody()) => submitActivation({ db: state.db, flags, now: () => clock, paused: () => false, custodyAllowed: () => true, frozen: async () => false }, partner, body);
const timeout = () => Object.assign(new Error("socket hang up https://horizon-testnet.stellar.org SECRET-IN-MESSAGE"), { name: "TimeoutError" });

beforeAll(async () => { pg = await activationDatabase(); state.db = drizzle(pg); }, 60_000);
afterAll(async () => { await pg?.close(); setAppLogger(null); });
beforeEach(async () => {
  clock = new Date(); paused = false; rail = new FakeRail();
  await seedActivation(pg);
  await reserve(validBody({ completedAt: new Date(clock.getTime() - 60_000).toISOString() }));
});

describe("the happy path", () => {
  it("sends exactly the grant to the user's address and confirms it", async () => {
    const result = await worker().tick();
    expect(result).toMatchObject({ ran: true, confirmed: 1 });
    expect(rail.built).toEqual([{ hash: "hash1", destination: ADDRESS, stroops: 11_000_000n }]);
    expect(await row()).toMatchObject({ state: "confirmed", tx_hash: "hash1", attempts: 1, error_code: null });
    expect((await row()).confirmed_at).not.toBeNull();
    expect(await audits()).toEqual(["activation_requested", "activation_funded"]);
    expect((await q("SELECT detail FROM audit_logs WHERE action='activation_funded'"))[0].detail).toMatchObject({ address: ADDRESS, amount: "1.1000000", txHash: "hash1" });
    expect(await balance()).toBe("98.8999000"); // the charge stands
  });

  it("does nothing on later ticks: a confirmed row is never sent again", async () => {
    await worker().tick(); await worker().tick(); await worker().tick();
    expect(rail.submitted).toHaveLength(1);
  });

  it("stores the hash, in state submitting, before it submits", async () => {
    let seen: any;
    rail.onSubmit = async () => { seen = await row(); };
    await worker().tick();
    expect(seen).toMatchObject({ state: "submitting", tx_hash: "hash1", attempts: 1 });
    expect(Number(seen.deadline)).toBe(Math.floor(clock.getTime() / 1000) + 120);
  });
});

describe("the account already exists", () => {
  it("is skipped, never sent to, and the partner is refunded exactly once", async () => {
    rail.existing.add(ADDRESS);
    await worker().tick(); await worker().tick();
    expect(rail.built).toHaveLength(0);
    expect(await row()).toMatchObject({ state: "skipped_already_active", error_code: "already-exists" });
    expect(await events()).toEqual([["new_wallet_activation", "-1.1001000"], ["stellar_tx_refund", "1.1001000"]]);
    expect(await balance()).toBe("100.0000000");
    expect((await row()).refund_billing_event_id).not.toBeNull();
    expect(await audits()).toEqual(["activation_requested", "activation_refunded"]);
  });
  it("op_already_exists from Horizon is handled the same way", async () => {
    rail.submitPlan = [{ accepted: false, code: "already-exists" }];
    await worker().tick();
    expect(await row()).toMatchObject({ state: "skipped_already_active" });
    expect(await balance()).toBe("100.0000000");
  });
  it("refunds nothing for a task Amma pays for", async () => {
    await seedActivation(pg, { payer: "amma" });
    await reserve();
    rail.existing.add(ADDRESS);
    await worker().tick();
    expect(await row()).toMatchObject({ state: "skipped_already_active", billing_event_id: null, refund_billing_event_id: null });
    expect(await events()).toEqual([]);
    expect(await audits()).toEqual(["activation_requested"]);
  });
});

describe("a failure that is certain", () => {
  it("is retried after a backoff and refunded once after three attempts", async () => {
    rail.submitPlan = [{ accepted: false, code: "bad-seq" }, { accepted: false, code: "fee" }, { accepted: false, code: "rejected" }];
    await worker().tick();
    expect(await row()).toMatchObject({ state: "failed", attempts: 1, error_code: "bad-seq" });
    await worker().tick(); // inside the backoff: nothing happens
    expect(rail.submitted).toHaveLength(1);
    advance(61);
    await worker().tick();
    expect(await row()).toMatchObject({ state: "failed", attempts: 2, error_code: "fee" });
    advance(120); await worker().tick(); // 300 s backoff after the second failure
    expect(rail.submitted).toHaveLength(2);
    advance(200);
    await worker().tick();
    expect(await row()).toMatchObject({ state: "refunded", attempts: 3, error_code: "rejected" });
    expect(await events()).toEqual([["new_wallet_activation", "-1.1001000"], ["stellar_tx_refund", "1.1001000"]]);
    expect(await balance()).toBe("100.0000000");
    expect(await audits()).toEqual(["activation_requested", "activation_failed", "activation_refunded"]);
    advance(10_000); await worker().tick(); await worker().tick();
    expect(rail.submitted).toHaveLength(3);
    expect(await events()).toHaveLength(2);
  });

  it("a later attempt can still succeed, and the charge stays", async () => {
    rail.submitPlan = [{ accepted: false, code: "bad-seq" }];
    await worker().tick();
    advance(61); await worker().tick();
    expect(await row()).toMatchObject({ state: "confirmed", attempts: 2 });
    expect(await events()).toHaveLength(1);
  });

  it("a transaction that failed on the ledger counts as a failed attempt", async () => {
    rail.submitPlan = [Object.assign(timeout())];
    await worker().tick();
    rail.ledger.set("hash1", "failed");
    await worker().tick();
    expect(await row()).toMatchObject({ state: "failed", error_code: "tx-failed" });
  });

  it("a failure for a task Amma pays for ends failed_final with nothing to refund", async () => {
    await seedActivation(pg, { payer: "amma" });
    await reserve();
    await pg.exec("UPDATE wallet_activations SET attempts = 2");
    rail.submitPlan = [{ accepted: false, code: "rejected" }];
    await worker().tick();
    expect(await row()).toMatchObject({ state: "failed_final", attempts: 3 });
    expect(await events()).toEqual([]);
    expect(await audits()).toEqual(["activation_requested", "activation_failed"]);
  });
});

describe("a timeout never double-sends", () => {
  it("keeps the hash, only looks it up, and confirms if it landed", async () => {
    rail.submitPlan = [timeout()];
    await worker().tick();
    expect(await row()).toMatchObject({ state: "submitted", tx_hash: "hash1" });
    advance(10); await worker().tick();
    expect(rail.built).toHaveLength(1);
    expect(rail.submitted).toEqual(["hash1"]);
    expect((await row()).state).toBe("submitted");
    rail.ledger.set("hash1", "success"); // it had landed after all
    advance(10); await worker().tick();
    expect(await row()).toMatchObject({ state: "confirmed", tx_hash: "hash1", attempts: 1 });
    expect(rail.submitted).toEqual(["hash1"]);
    expect(await audits()).toEqual(["activation_requested", "activation_funded"]);
  });

  it("builds a second transaction only after the first can no longer be included", async () => {
    rail.submitPlan = [timeout()];
    await worker().tick();
    advance(120 + 29); await worker().tick(); // maxTime passed, grace not
    expect(rail.built).toHaveLength(1);
    expect((await row()).state).toBe("submitted");
    advance(2); await worker().tick(); // now provably dead
    expect(await row()).toMatchObject({ state: "failed", error_code: "expired", attempts: 1 });
    expect(rail.built).toHaveLength(1);
    advance(61); await worker().tick();
    expect(rail.built).toHaveLength(2);
    expect(await row()).toMatchObject({ state: "confirmed", tx_hash: "hash2", attempts: 2 });
  });

  it("a crash after the hash was stored recovers by hash on the next run", async () => {
    await pg.exec("UPDATE wallet_activations SET state='submitting', attempts=1, tx_hash='hashX', deadline='" + (Math.floor(clock.getTime() / 1000) + 100) + "'");
    await worker().tick();
    expect(rail.built).toHaveLength(0);
    expect((await row()).state).toBe("submitting");
    rail.ledger.set("hashX", "success");
    await worker().tick();
    expect(await row()).toMatchObject({ state: "confirmed", tx_hash: "hashX" });
    expect(rail.submitted).toHaveLength(0);
  });

  it("a crash before any hash was stored is handed back after two minutes, without costing an attempt", async () => {
    await pg.query("UPDATE wallet_activations SET state='submitting', attempts=1, updated_at=$1", [clock.toISOString()]);
    await worker().tick();
    expect((await row()).state).toBe("submitting");
    advance(121);
    await worker().tick();
    expect(await row()).toMatchObject({ state: "confirmed", attempts: 1 });
  });
});

describe("Horizon trouble before anything is sent", () => {
  it("gives the attempt back instead of using one up", async () => {
    rail.accountError = Object.assign(new Error("boom"), { response: { status: 503 } });
    for (let i = 0; i < 5; i++) await worker().tick();
    expect(await row()).toMatchObject({ state: "reserved", attempts: 0 });
    expect(rail.built).toHaveLength(0);
    rail.accountError = undefined;
    await worker().tick();
    expect((await row()).state).toBe("confirmed");
    rail.buildError = undefined;
  });
  it("does the same when the treasury account cannot be loaded for building", async () => {
    rail.buildError = new Error("no horizon");
    await worker().tick();
    expect(await row()).toMatchObject({ state: "reserved", attempts: 0 });
  });
});

describe("treasury floor", () => {
  const logs: { level: string; o: any; m: string }[] = [];
  beforeEach(() => { logs.length = 0; setAppLogger({ info: (o, m) => logs.push({ level: "info", o, m }), warn: (o, m) => logs.push({ level: "warn", o, m }), error: (o, m) => logs.push({ level: "error", o, m }) }); });
  it("refuses to send below 2x the grant and says so", async () => {
    rail.treasury = 21_900_000n;
    await worker().tick();
    expect(rail.built).toHaveLength(0);
    expect((await row()).state).toBe("reserved");
    expect(logs.map((l) => l.m)).toContain("activation_treasury_refused");
  });
  it("sends but warns below 20x the grant", async () => {
    rail.treasury = 219_000_000n;
    await worker().tick();
    expect((await row()).state).toBe("confirmed");
    expect(logs.find((l) => l.m === "activation_treasury_low")?.level).toBe("warn");
  });
  it("is silent with a healthy treasury", async () => {
    await worker().tick();
    expect(logs.map((l) => l.m)).toEqual(["activation_funded"]);
  });
  it("does not send when the treasury cannot be read", async () => {
    rail.treasuryStroops = async () => { throw new Error("down"); };
    await worker().tick();
    expect(rail.built).toHaveLength(0);
  });
});

describe("switches", () => {
  it("does nothing while paused, or when the flag is off", async () => {
    paused = true;
    expect(await worker().tick()).toMatchObject({ ran: false });
    expect(await worker({ flags: { ...flags, enabled: false } }).tick()).toMatchObject({ ran: false });
    expect((await row()).state).toBe("reserved");
    paused = false;
    await worker().tick();
    expect((await row()).state).toBe("confirmed");
  });
  it("stops mid-batch when paused", async () => {
    let calls = 0;
    await worker({ paused: () => ++calls > 4 }).tick();
    expect((await row()).state).toMatch(/reserved|confirmed|submitting|submitted/);
  });
  it("only one tick runs at a time in this process", async () => {
    rail.onSubmit = async () => { await new Promise((r) => setTimeout(r, 30)); };
    const w = worker();
    const [a, b] = await Promise.all([w.tick(), w.tick()]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(rail.submitted).toHaveLength(1);
  });
  it("does nothing while another runner holds the session lock", async () => {
    const w = worker({ sessionLock: async () => null });
    expect(await w.tick()).toMatchObject({ ran: false });
    expect(rail.built).toHaveLength(0);
    expect((await row()).state).toBe("reserved");
  });
  it("holds the session lock for the whole tick and releases it afterwards, even after an error", async () => {
    const events: string[] = [];
    const lock = async () => { events.push("lock"); return async () => { events.push("unlock"); }; };
    rail.onSubmit = async () => { events.push("submit"); };
    await worker({ sessionLock: lock }).tick();
    expect(events).toEqual(["lock", "submit", "unlock"]);
    events.length = 0;
    rail.treasuryStroops = async () => { throw new Error("x"); };
    await worker({ sessionLock: lock }).tick();
    expect(events).toEqual(["lock", "unlock"]);
    events.length = 0;
    const exploding = worker({ sessionLock: lock, db: { execute: async () => { throw new Error("db"); }, transaction: async () => { throw new Error("db"); } } as any });
    await expect(exploding.tick()).rejects.toThrow();
    expect(events).toEqual(["lock", "unlock"]);
  });
  it("two runners over the same row send it once", async () => {
    await Promise.all([worker().tick(), worker().tick()]);
    await worker().tick();
    expect(rail.submitted).toHaveLength(1);
  });
});

describe("Horizon lag and transactions that land late", () => {
  const tx = async () => (await row()) as { state: string; tx_hash: string; tx_hashes: string[]; attempts: number };
  const refunds = async () => (await events()).filter((e) => e[0] === "stellar_tx_refund");

  it("the stall: the transaction lands, Horizon says 404 past the deadline, then it appears: confirmed, never refunded", async () => {
    rail.submitPlan = [timeout()];
    await worker().tick();
    rail.ledgerAt = Math.floor(clock.getTime() / 1000); // Horizon stopped ingesting here
    advance(120 + 600);
    for (let i = 0; i < 3; i++) { await worker().tick(); advance(15); }
    expect(await tx()).toMatchObject({ state: "submitted", tx_hash: "hash1" });
    expect(rail.built).toHaveLength(1);
    expect(await refunds()).toEqual([]);
    rail.ledger.set("hash1", "success"); // Horizon catches up and shows the transaction
    await worker().tick();
    expect(await tx()).toMatchObject({ state: "confirmed", tx_hash: "hash1", attempts: 1 });
    expect(await refunds()).toEqual([]);
    expect(await balance()).toBe("98.8999000");
    expect(rail.submitted).toEqual(["hash1"]);
  });

  it("a transaction is dead only once Horizon has ingested past its time bounds", async () => {
    rail.submitPlan = [timeout()];
    await worker().tick();
    const deadline = Number((await row()).deadline);
    advance(10_000);
    rail.ledgerAt = deadline + 30; // exactly the grace: not past it
    await worker().tick();
    expect((await row()).state).toBe("submitted");
    rail.ledgerAt = deadline + 31;
    await worker().tick();
    expect(await tx()).toMatchObject({ state: "failed", attempts: 1 });
  });

  it("an unreadable ledger is not proof of anything", async () => {
    rail.submitPlan = [timeout()];
    await worker().tick();
    advance(10_000);
    rail.ledgerError = new Error("horizon down");
    await worker().tick();
    expect((await row()).state).toBe("submitted");
  });

  it("keeps every attempt's hash, in order, and never clears one", async () => {
    rail.submitPlan = [{ accepted: false, code: "bad-seq" }, { accepted: false, code: "fee" }, { accepted: false, code: "rejected" }];
    await worker().tick(); advance(61); await worker().tick();
    expect(await tx()).toMatchObject({ tx_hash: "hash2", tx_hashes: ["hash1", "hash2"] });
    advance(301); await worker().tick();
    expect(await tx()).toMatchObject({ state: "refunded", tx_hash: "hash3", tx_hashes: ["hash1", "hash2", "hash3"] });
  });

  it("an earlier attempt that landed late turns a later 'account already exists' into a confirmation, not a refund", async () => {
    rail.submitPlan = [timeout()];
    await worker().tick();
    advance(200); await worker().tick(); // provably dead by the ledger: failed(expired)
    expect((await row()).state).toBe("failed");
    rail.ledger.set("hash1", "success"); rail.existing.add(ADDRESS); // it landed after all
    advance(61); await worker().tick();
    expect(await tx()).toMatchObject({ state: "confirmed", tx_hash: "hash1" });
    expect(await refunds()).toEqual([]);
    expect(await balance()).toBe("98.8999000");
    expect(rail.built).toHaveLength(1);
  });

  it("the same for op_already_exists and tx_bad_seq answered by Horizon on a retry", async () => {
    for (const code of ["already-exists", "bad-seq"]) {
      await seedActivation(pg); await reserve(validBody({ completedAt: new Date(clock.getTime() - 60_000).toISOString() }));
      rail = new FakeRail();
      rail.submitPlan = [timeout(), { accepted: false, code }];
      await worker().tick();
      advance(200); await worker().tick();
      rail.ledger.set("hash1", "success");
      advance(61); await worker().tick();
      expect(await tx()).toMatchObject({ state: "confirmed", tx_hash: "hash1" });
      expect(await refunds()).toEqual([]);
    }
  });

  it("a last failed attempt looks at every earlier hash before it refunds", async () => {
    rail.submitPlan = [timeout()];
    await worker().tick();
    await pg.exec("UPDATE wallet_activations SET attempts = 3, tx_hashes = ARRAY['hashOld','hash1']");
    rail.ledger.set("hashOld", "success");
    advance(10_000);
    await worker().tick();
    expect(await tx()).toMatchObject({ state: "confirmed", tx_hash: "hashOld" });
    expect(await refunds()).toEqual([]);
  });

  it("does not refund while Horizon cannot answer for one of the hashes", async () => {
    rail.submitPlan = [timeout()];
    await worker().tick();
    await pg.exec("UPDATE wallet_activations SET attempts = 3, tx_hashes = ARRAY['hashOld','hash1']");
    rail.lookupFails.add("hashOld");
    advance(10_000);
    await worker().tick();
    expect((await row()).state).toBe("submitted");
    expect(await refunds()).toEqual([]);
    rail.lookupFails.clear();
    await worker().tick();
    expect(await tx()).toMatchObject({ state: "refunded" });
    expect(await refunds()).toHaveLength(1);
  });
});

describe("postgresSessionLock", () => {
  const client = (locked: boolean, fail = false) => {
    const calls: string[] = [];
    const conn: any = async (strings: TemplateStringsArray) => { calls.push(strings.join("?")); if (fail) throw new Error("boom"); return [{ locked }]; };
    conn.release = () => calls.push("release");
    return { calls, client: { reserve: async () => conn } };
  };
  it("takes pg_try_advisory_lock(731241, 13) on one reserved connection and unlocks on that connection", async () => {
    const { calls, client: c } = client(true);
    const release = await postgresSessionLock(c)();
    expect(calls).toEqual(["SELECT pg_try_advisory_lock(731241, 13) AS locked"]);
    await release!();
    expect(calls).toEqual(["SELECT pg_try_advisory_lock(731241, 13) AS locked", "SELECT pg_advisory_unlock(731241, 13)", "release"]);
  });
  it("gives the connection back and returns null when someone else holds the lock", async () => {
    const { calls, client: c } = client(false);
    expect(await postgresSessionLock(c)()).toBeNull();
    expect(calls).toEqual(["SELECT pg_try_advisory_lock(731241, 13) AS locked", "release"]);
  });
  it("the business floor check takes its own lock, 20", async () => {
    const { calls, client: c } = client(true);
    const release = await postgresSessionLock(c, "business-floor")();
    await release!();
    expect(calls).toEqual(["SELECT pg_try_advisory_lock(731241, 20) AS locked", "SELECT pg_advisory_unlock(731241, 20)", "release"]);
  });
  it("the fee sweeper takes its own lock, 17", async () => {
    const { calls, client: c } = client(true);
    const release = await postgresSessionLock(c, "fee-sweeps")();
    await release!();
    expect(calls).toEqual(["SELECT pg_try_advisory_lock(731241, 17) AS locked", "SELECT pg_advisory_unlock(731241, 17)", "release"]);
  });
  it("the business deposit watcher takes its own lock, 15", async () => {
    const { calls, client: c } = client(true);
    const release = await postgresSessionLock(c, "business-deposits")();
    await release!();
    expect(calls).toEqual(["SELECT pg_try_advisory_lock(731241, 15) AS locked", "SELECT pg_advisory_unlock(731241, 15)", "release"]);
  });
  it("gives the connection back when the query fails", async () => {
    const { calls, client: c } = client(true, true);
    await expect(postgresSessionLock(c)()).rejects.toThrow();
    expect(calls.at(-1)).toBe("release");
  });
});

describe("only this network's stellar rows are touched", () => {
  it("leaves rows on another network alone", async () => {
    await pg.exec("UPDATE wallet_activations SET network = 'public'");
    await worker().tick();
    expect(rail.built).toHaveLength(0);
  });
});

describe("secrets and bodies stay out of logs, rows and audits", () => {
  it("never records the treasury secret, an exception message or a response body", async () => {
    const secret = Keypair.random().secret();
    const logs: string[] = [];
    const push = (o: unknown, m: string) => logs.push(JSON.stringify([o, m]));
    setAppLogger({ info: push, warn: push, error: push });
    const kp = Keypair.fromSecret(secret);
    const { Account } = await import("@stellar/stellar-sdk");
    const failing = Object.assign(new Error(`submit failed secret=${secret} body=<html>leak</html>`), { name: "TimeoutError", response: { status: 504, data: { leak: secret } } });
    let attempt = 0;
    const server: any = {
      loadAccount: async (id: string) => { if (id === ADDRESS) throw Object.assign(new Error(`not found ${secret}`), { response: { status: 404 } }); return Object.assign(new Account(kp.publicKey(), "100"), { balances: [{ asset_type: "native", balance: "1000.0000000" }] }); },
      submitTransaction: async () => { if (attempt++ === 0) throw failing; return {}; },
      ledgers: () => ({ order: () => ({ limit: () => ({ call: async () => ({ records: [{ closed_at: clock.toISOString() }] }) }) }) }),
      transactions: () => ({ transaction: () => ({ call: async () => { throw Object.assign(new Error(`lookup ${secret}`), { response: { status: 404 } }); } }) }),
    };
    const real = horizonRail(server, secret, "Test SDF Network ; September 2015");
    const w = new ActivationWorker({ db: state.db, rail: real, flags, paused: () => false, sessionLock: noLock, now: () => clock });
    await w.tick();
    advance(121 + 31); await w.tick();
    advance(61); await w.tick();
    const everything = JSON.stringify([logs, await q("SELECT * FROM wallet_activations"), await q("SELECT * FROM audit_logs"), await q("SELECT * FROM billing_events")]);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("leak");
    expect(everything).not.toContain("horizon-testnet");
    expect(logs.length).toBeGreaterThan(0);
    expect(codeOf(failing)).toBe("timeout");
    expect(codeOf(new Error("x"))).toBe("horizon-unavailable");
  });
});
