import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { activationDatabase } from "../../db/migrations/activation.test-support";
import { ADDRESS, ADDRESS_2, seedActivation, validBody } from "./activation.test-support";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../../db", async () => ({ get db() { return state.db; }, schema: await import("../../db/schema") }));
vi.mock("../../lib/mailer", () => ({ sendEmail: vi.fn() }));
const notify = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../services/billing.service", async (orig) => ({ ...(await orig<typeof import("../../services/billing.service")>()), maybeNotifyDeficit: notify }));

import { activationView, assertAvailable, digestOf, parseRequest, stroopsToXlm, submitActivation, type IntakeDeps } from "./intake";
import type { PartnerContext } from "./partner-auth";
import type { ActivationFlags } from "../../lib/activation-flags";

let pg: PGlite;
const flags: ActivationFlags = { enabled: true, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: 11_000_000n, globalDailyCap: 1000, userDailyCap: 3 };
const partner: PartnerContext = { tenantId: 1, tenantName: "LMS", apiKeyId: 1, signingKeyId: 1, dailyCap: 50, allowDebt: false };
let frozen = false, allowed = (_id: number) => true;
const deps = (over: Partial<IntakeDeps> = {}): IntakeDeps => ({ db: state.db, flags, now: () => new Date(), paused: () => false, custodyAllowed: (id) => allowed(id), frozen: async () => frozen, ...over });
const submit = (body: unknown, p: Partial<PartnerContext> = {}, d: Partial<IntakeDeps> = {}) => submitActivation(deps(d), { ...partner, ...p }, body);
const fails = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return `${(e as any).code}:${(e as any).status}`; } };
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const balance = async () => (await q("SELECT prepaid_xlm_balance AS b FROM tenants WHERE id=1"))[0].b as string;
const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`))[0].n);

async function addUser2() {
  await pg.query("INSERT INTO tenant_users (tenant_id, user_id) VALUES (1,2)");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (2,'stellar','testnet',$1,'w',true,0)", [ADDRESS_2]);
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (2,'phrase',$1,'local','custody')", ["s".repeat(60)]);
}
const body2 = (n = 2) => validBody({ ammaUserId: n, completionId: `completion-000${n}`, idempotencyKey: `idem-key-000${n}` });

beforeAll(async () => { pg = await activationDatabase(); state.db = drizzle(pg); }, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => { frozen = false; allowed = () => true; await seedActivation(pg); });

describe("request validation (step 3)", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const ok = validBody({ completedAt: "2026-11-16T11:00:00Z" });
  it("accepts the documented shape and normalises nothing", () => {
    expect(parseRequest(ok, now)).toEqual(ok);
    expect(parseRequest({ ...ok, completedAt: "2026-11-16T11:00:00.123+02:00" }, now).completedAt).toBe("2026-11-16T11:00:00.123+02:00");
  });
  it.each([
    ["not an object", "x"], ["array", []], ["null", null],
    ["unknown field", { ...ok, extra: 1 }], ["missing field", { ...ok, taskKey: undefined }],
    ["user id as string", { ...ok, ammaUserId: "1" }], ["user id zero", { ...ok, ammaUserId: 0 }], ["user id negative", { ...ok, ammaUserId: -1 }],
    ["user id fraction", { ...ok, ammaUserId: 1.5 }], ["user id unsafe", { ...ok, ammaUserId: 2 ** 60 }],
    ["task key upper case", { ...ok, taskKey: "Course:Intro" }], ["task key empty", { ...ok, taskKey: "" }], ["task key too long", { ...ok, taskKey: "a".repeat(81) }], ["task key space", { ...ok, taskKey: "a b" }],
    ["completion id short", { ...ok, completionId: "short" }], ["completion id long", { ...ok, completionId: "x".repeat(101) }], ["completion id with space", { ...ok, completionId: "has a space1" }],
    ["idempotency key short", { ...ok, idempotencyKey: "1234567" }], ["idempotency key control char", { ...ok, idempotencyKey: "abcdefgh\n" }],
    ["completedAt not ISO", { ...ok, completedAt: "yesterday" }], ["completedAt date only", { ...ok, completedAt: "2026-11-16" }], ["completedAt no zone", { ...ok, completedAt: "2026-11-16T11:00:00" }],
    ["completedAt 31 days old", { ...ok, completedAt: "2026-10-15T11:00:00Z" }], ["completedAt in the future", { ...ok, completedAt: "2026-11-16T12:10:00Z" }],
  ])("rejects %s with 400", (_n, body) => {
    expect(() => parseRequest(body, now)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST", status: 400 }));
  });
  it("accepts 30 days minus a minute and 4 minutes of clock skew", () => {
    expect(() => parseRequest({ ...ok, completedAt: "2026-10-17T12:01:00Z" }, now)).not.toThrow();
    expect(() => parseRequest({ ...ok, completedAt: "2026-11-16T12:04:00Z" }, now)).not.toThrow();
  });
  it("digests the fields, not the JSON text", () => {
    expect(digestOf(parseRequest(ok, now))).toBe(digestOf(parseRequest(JSON.parse(JSON.stringify(ok, Object.keys(ok).reverse())), now)));
    expect(digestOf(parseRequest(ok, now))).not.toBe(digestOf(parseRequest({ ...ok, taskKey: "course:other" }, now)));
  });
  it("formats stroops as an XLM string", () => { expect(stroopsToXlm(11_000_000n)).toBe("1.1000000"); expect(stroopsToXlm(1n)).toBe("0.0000001"); });
});

describe("switch and pause (step 1)", () => {
  it("answers 503 when off or paused", () => {
    expect(() => assertAvailable({ flags: { ...flags, enabled: false }, paused: () => false })).toThrowError(expect.objectContaining({ code: "ACTIVATION_OFF", status: 503 }));
    expect(() => assertAvailable({ flags, paused: () => true })).toThrowError(expect.objectContaining({ code: "ACTIVATION_PAUSED", status: 503, retryable: true }));
    expect(() => assertAvailable({ flags, paused: () => false })).not.toThrow();
  });
});

describe("accepting an activation", () => {
  it("reserves, charges grant + fee in the same transaction and audits", async () => {
    const result = await submit(validBody());
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ activationId: "1", completionId: "completion-0001", taskKey: "course:intro", status: "pending", chains: [{ chain: "stellar", network: "testnet", address: ADDRESS, state: "reserved" }] });
    expect(await balance()).toBe("98.8999000");
    expect(await q("SELECT event_type, amount_xlm, wallet_funding_snapshot AS g, platform_fee_snapshot AS f, user_id, api_key_id, created_by FROM billing_events")).toEqual([
      { event_type: "new_wallet_activation", amount_xlm: "-1.1001000", g: "1.1000", f: "0.0001", user_id: 1, api_key_id: 1, created_by: "activation" }]);
    const [row] = await q("SELECT state, grant_base_units, payer, attempts, billing_event_id, network, address, tx_hash FROM wallet_activations");
    expect(row).toMatchObject({ state: "reserved", grant_base_units: "11000000", payer: "tenant", attempts: 0, network: "testnet", address: ADDRESS, tx_hash: null });
    expect(Number(row.billing_event_id)).toBe(1);
    const audit = await q("SELECT user_id, action, detail FROM audit_logs");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: 1, action: "activation_requested" });
    expect(audit[0].detail).toMatchObject({ tenantId: 1, taskKey: "course:intro", billed: "1.1001000" });
  });

  it("takes the address from Amma's records, never the request", async () => {
    await expect(submit({ ...validBody(), address: "GEVIL" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect((await submit(validBody())).body.chains[0].address).toBe(ADDRESS);
  });

  it("uses the configured grant", async () => {
    await submit(validBody(), {}, { flags: { ...flags, stellarGrantStroops: 20_000_000n } });
    expect((await q("SELECT amount_xlm FROM billing_events"))[0].amount_xlm).toBe("-2.0001000");
    expect((await q("SELECT grant_base_units g FROM wallet_activations"))[0].g).toBe("20000000");
  });
});

describe("idempotency (step 4)", () => {
  it("returns the same result for the same key and digest, without a second charge or row", async () => {
    const first = await submit(validBody());
    const again = await submit(validBody());
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await balance()).toBe("98.8999000");
    expect(await count("wallet_activations")).toBe(1);
    expect(await count("billing_events")).toBe(1);
    expect(await count("partner_task_completions")).toBe(1);
  });
  it("replays the stored result even when the user would no longer be eligible", async () => {
    await submit(validBody());
    allowed = () => false; frozen = true;
    expect((await submit(validBody())).status).toBe(200);
  });
  it("the same key with any other field is a 409", async () => {
    await submit(validBody());
    for (const change of [{ taskKey: "course:other" }, { completionId: "completion-9999" }, { ammaUserId: 2 }, { completedAt: new Date(Date.now() - 120_000).toISOString() }])
      expect(await fails(submit(validBody(change)))).toBe("IDEMPOTENCY_MISMATCH:409");
    expect(await count("wallet_activations")).toBe(1);
  });
  it("two simultaneous identical requests charge once", async () => {
    const [a, b] = await Promise.all([submit(validBody()), submit(validBody())]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body).toEqual(b.body);
    expect(await count("billing_events")).toBe(1);
    expect(await balance()).toBe("98.8999000");
  });
});

describe("eligibility, in the spec's order (steps 5-9)", () => {
  const nothingWritten = async () => { for (const t of ["partner_task_completions", "wallet_activations", "billing_events"]) expect(await count(t)).toBe(0); expect(await balance()).toBe("100.0000000"); };

  it("5: an unknown user and a user outside the allow-list get the same generic answer", async () => {
    expect(await fails(submit(validBody({ ammaUserId: 999 })))).toBe("NOT_ELIGIBLE:403");
    allowed = (id) => id !== 1;
    expect(await fails(submit(validBody()))).toBe("NOT_ELIGIBLE:403");
    await nothingWritten();
  });
  it("5 comes before 6, 6 before 7, 7 before 8, 8 before 9", async () => {
    await pg.exec("DELETE FROM tenant_users; DELETE FROM partner_tasks; DELETE FROM user_wallets");
    allowed = () => false;
    expect(await fails(submit(validBody()))).toBe("NOT_ELIGIBLE:403");
    allowed = () => true;
    expect(await fails(submit(validBody()))).toBe("NOT_ELIGIBLE:403");
    expect((await q("SELECT detail FROM audit_logs WHERE action = 'activation_rejected' ORDER BY id")).map((r) => r.detail.reason)).toEqual(["not_allowlisted", "user_not_linked"]);
    await pg.exec("INSERT INTO tenant_users (tenant_id, user_id) VALUES (1,1); UPDATE users SET signing_mode='self'");
    expect(await fails(submit(validBody()))).toBe("WALLET_NOT_AMMA_HELD:409");
    await pg.exec("UPDATE users SET signing_mode='delegated'");
    expect(await fails(submit(validBody()))).toBe("TASK_UNKNOWN:404");
    await pg.exec("INSERT INTO partner_tasks (tenant_id, task_key, name, chains, created_by) VALUES (1,'course:intro','I','{stellar}','t')");
    expect(await fails(submit(validBody()))).toBe("WALLET_NOT_AMMA_HELD:409");
    await nothingWritten();
  });
  it("6: a user who never signed in to this partner is refused", async () => {
    await pg.exec("DELETE FROM tenant_users");
    expect(await fails(submit(validBody()))).toBe("NOT_ELIGIBLE:403");
    // A link to another tenant does not count.
    await pg.exec("INSERT INTO tenants (id, slug, name) VALUES (2,'other','Other'); INSERT INTO tenant_users (tenant_id, user_id) VALUES (2,1)");
    expect(await fails(submit(validBody()))).toBe("NOT_ELIGIBLE:403");
  });
  it("7: self-custody, no Amma phrase, a recovery freeze and an unverified email are each refused", async () => {
    await pg.exec("UPDATE users SET signing_mode='self'");
    expect(await fails(submit(validBody()))).toBe("WALLET_NOT_AMMA_HELD:409");
    await pg.exec("UPDATE users SET signing_mode='delegated'; UPDATE wallet_key_escrow SET origin='import'");
    expect(await fails(submit(validBody()))).toBe("WALLET_NOT_AMMA_HELD:409");
    await pg.exec("UPDATE wallet_key_escrow SET origin='custody'");
    frozen = true;
    expect(await fails(submit(validBody()))).toBe("ACCOUNT_FROZEN:423");
    frozen = false;
    await pg.exec("UPDATE users SET is_email_verified=false");
    expect(await fails(submit(validBody()))).toBe("EMAIL_NOT_VERIFIED:409");
    await nothingWritten();
  });
  it("8: unknown, inactive and expired tasks, another tenant's task, a repeat completion and a reused completion id", async () => {
    expect(await fails(submit(validBody({ taskKey: "course:nope" })))).toBe("TASK_UNKNOWN:404");
    await pg.exec("UPDATE partner_tasks SET is_active=false");
    expect(await fails(submit(validBody()))).toBe("TASK_UNKNOWN:404");
    await pg.exec("UPDATE partner_tasks SET is_active=true, expires_at = now() - interval '1 second'");
    expect(await fails(submit(validBody()))).toBe("TASK_UNKNOWN:404");
    await pg.exec("UPDATE partner_tasks SET expires_at = NULL");
    expect(await fails(submit(validBody(), { tenantId: 2 }))).toBe("NOT_ELIGIBLE:403");
    await nothingWritten();
    await submit(validBody());
    expect(await fails(submit(validBody({ idempotencyKey: "idem-key-9999", completionId: "completion-9999" })))).toBe("ALREADY_COMPLETED:409");
    await pg.exec("INSERT INTO partner_tasks (tenant_id, task_key, name, chains, created_by) VALUES (1,'course:two','Two','{stellar}','t')");
    expect(await fails(submit(validBody({ taskKey: "course:two", idempotencyKey: "idem-key-8888" })))).toBe("COMPLETION_DUPLICATE:409");
  });
  it("8: tasks Amma pays for need an account at least a day old", async () => {
    await seedActivation(pg, { payer: "amma" });
    await pg.exec("UPDATE users SET created_at = now() - interval '2 hours'");
    expect(await fails(submit(validBody()))).toBe("ACCOUNT_TOO_NEW:409");
    await pg.exec("UPDATE users SET created_at = now() - interval '25 hours'");
    expect((await submit(validBody())).status).toBe(202);
  });
  it("9: no index-0 Amma-held address on this network is refused, and an index-1 wallet does not stand in", async () => {
    await pg.exec("UPDATE user_wallets SET derivation_index = 1");
    expect(await fails(submit(validBody()))).toBe("WALLET_NOT_AMMA_HELD:409");
    await pg.exec("UPDATE user_wallets SET derivation_index = NULL");
    expect(await fails(submit(validBody()))).toBe("WALLET_NOT_AMMA_HELD:409");
    await pg.exec("UPDATE user_wallets SET derivation_index = 0, network = 'public'");
    expect(await fails(submit(validBody()))).toBe("WALLET_NOT_AMMA_HELD:409");
    await nothingWritten();
    expect(await fails(submit(validBody(), {}, { flags: { ...flags, mainnet: true, network: "public" } }))).toBe("ok");
  });
  it("9: an address that already has a live activation is recorded as skipped, with no charge", async () => {
    await pg.exec("INSERT INTO partner_tasks (tenant_id, task_key, name, chains, created_by) VALUES (1,'course:two','Two','{stellar}','t')");
    await submit(validBody());
    const second = await submit(validBody({ taskKey: "course:two", completionId: "completion-0002", idempotencyKey: "idem-key-0002" }));
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ status: "skipped", chains: [{ chain: "stellar", state: "skipped_already_active" }] });
    expect(await count("billing_events")).toBe(1);
    expect(await balance()).toBe("98.8999000");
    expect((await q("SELECT state, grant_base_units g, billing_event_id b FROM wallet_activations WHERE completion_id = 2"))[0]).toEqual({ state: "skipped_already_active", g: "0", b: null });
  });
  it("9: a refunded earlier attempt does not block a new activation of the same address", async () => {
    await pg.exec("INSERT INTO partner_tasks (tenant_id, task_key, name, chains, created_by) VALUES (1,'course:two','Two','{stellar}','t')");
    await submit(validBody());
    await pg.exec("UPDATE wallet_activations SET state='refunded'");
    const second = await submit(validBody({ taskKey: "course:two", completionId: "completion-0002", idempotencyKey: "idem-key-0002" }));
    expect(second.body.chains[0].state).toBe("reserved");
  });
  it("9: a chain the task lists but the server does not run is reported and never stored or charged", async () => {
    await pg.exec("UPDATE partner_tasks SET chains = '{stellar,xrpl,evm}'");
    const result = await submit(validBody());
    expect(result.body.chains).toEqual([{ chain: "stellar", network: "testnet", address: ADDRESS, state: "reserved" }, { chain: "xrpl", state: "skipped_chain_unavailable" }, { chain: "evm", state: "skipped_chain_unavailable" }]);
    expect(await count("wallet_activations")).toBe(1);
    expect(await balance()).toBe("98.8999000");
    await seedActivation(pg);
    await pg.exec("UPDATE partner_tasks SET chains = '{xrpl}'");
    const only = await submit(validBody());
    expect(only.body).toMatchObject({ status: "skipped", chains: [{ chain: "xrpl", state: "skipped_chain_unavailable" }] });
    expect(await count("wallet_activations")).toBe(0);
    expect(await balance()).toBe("100.0000000");
  });
});

describe("caps (step 10)", () => {
  const code = (b: unknown, p: Partial<PartnerContext> = {}, d: Partial<IntakeDeps> = {}) => fails(submit(b, p, d));
  it("per user across partners, per task per day, per task in total, per tenant per day, and the global breaker", async () => {
    expect(await code(validBody(), {}, { flags: { ...flags, userDailyCap: 0 } })).toBe("CAP_REACHED:429");
    await pg.exec("UPDATE partner_tasks SET daily_cap = 0");
    expect(await code(validBody())).toBe("CAP_REACHED:429");
    await pg.exec("UPDATE partner_tasks SET daily_cap = NULL, total_cap = 0");
    expect(await code(validBody())).toBe("CAP_REACHED:429");
    await pg.exec("UPDATE partner_tasks SET total_cap = NULL");
    expect(await code(validBody(), { dailyCap: 0 })).toBe("CAP_REACHED:429");
    expect(await code(validBody(), {}, { flags: { ...flags, globalDailyCap: 0 } })).toBe("CAP_REACHED:429");
    expect(await count("wallet_activations") + await count("billing_events")).toBe(0);
    expect(await code(validBody())).toBe("ok");
  });
  it("tells the partner when to retry", async () => {
    try { await submit(validBody(), { dailyCap: 0 }); } catch (e) { expect(e).toMatchObject({ retryable: true, retryAfter: 3600 }); }
  });
  it("counts in-flight rows and ignores skipped, refunded and failed_final ones", async () => {
    await addUser2();
    expect(await code(validBody(), { dailyCap: 1 })).toBe("ok");
    expect(await code(body2(), { dailyCap: 1 })).toBe("CAP_REACHED:429");
    await pg.exec("UPDATE wallet_activations SET state='refunded'");
    expect(await code(body2(), { dailyCap: 1 })).toBe("ok");
  });
  it("counts only the last 24 hours", async () => {
    await addUser2();
    await submit(validBody());
    await pg.exec("UPDATE wallet_activations SET created_at = now() - interval '25 hours'");
    expect(await code(body2(), { dailyCap: 1 })).toBe("ok");
  });
  it("concurrent requests never exceed a cap", async () => {
    await addUser2();
    await pg.exec("INSERT INTO users (id, email, password_hash, is_email_verified, signing_mode, created_at) VALUES (3,'three@example.invalid','x',true,'delegated', now() - interval '3 days'), (4,'four@example.invalid','x',true,'delegated', now() - interval '3 days')");
    for (const n of [3, 4]) {
      await pg.query("INSERT INTO tenant_users (tenant_id, user_id) VALUES (1,$1)", [n]);
      await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES ($1,'stellar','testnet',$2,'w',true,0)", [n, `GADDR${n}`.padEnd(56, "0")]);
      await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES ($1,'phrase',$2,'local','custody')", [n, "s".repeat(60)]);
    }
    const results = await Promise.all([1, 2, 3, 4].map((n) => fails(submit(body2(n), { dailyCap: 2 }))));
    expect([...results].sort()).toEqual(["CAP_REACHED:429", "CAP_REACHED:429", "ok", "ok"]);
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
    expect(results.filter((r) => r === "CAP_REACHED:429")).toHaveLength(2);
    expect(await count("wallet_activations")).toBe(2);
    expect(await count("billing_events")).toBe(2);
  });
});

describe("budget and debt (step 11)", () => {
  it("refuses when the balance cannot cover the grant and fee, and writes nothing", async () => {
    await seedActivation(pg, { balance: "1.1000" });
    expect(await fails(submit(validBody()))).toBe("BUDGET_EXHAUSTED:402");
    await seedActivation(pg, { balance: "0" });
    expect(await fails(submit(validBody()))).toBe("BUDGET_EXHAUSTED:402");
    expect(await count("partner_task_completions") + await count("billing_events")).toBe(0);
    expect(await balance()).toBe("0.0000000");
  });
  it("allows exactly enough", async () => {
    await seedActivation(pg, { balance: "1.1001" });
    expect((await submit(validBody())).status).toBe(202);
    expect(await balance()).toBe("0.0000000");
  });
  it("never allows debt unless the settings and policy do, and never on mainnet", async () => {
    await seedActivation(pg, { balance: "0" });
    expect(await fails(submit(validBody(), { allowDebt: true }))).toBe("ok");
    expect(await balance()).toBe("-1.1001000");
    await seedActivation(pg, { balance: "0" });
    await pg.exec("UPDATE tenant_billing_policy SET acquisition_mode_enabled = false");
    expect(await fails(submit(validBody(), { allowDebt: true }))).toBe("BUDGET_EXHAUSTED:402");
    await seedActivation(pg, { balance: "0" });
    await pg.exec("UPDATE user_wallets SET network = 'public'");
    expect(await fails(submit(validBody(), { allowDebt: true }, { flags: { ...flags, mainnet: true, network: "public" } }))).toBe("BUDGET_EXHAUSTED:402");
    await seedActivation(pg, { balance: "-299.5" });
    expect(await fails(submit(validBody(), { allowDebt: true }))).toBe("BUDGET_EXHAUSTED:402");
  });
  it("refuses a suspended or inactive tenant even after authentication, and a tenant without a policy", async () => {
    await pg.exec("UPDATE tenants SET suspended_at = now()");
    expect(await fails(submit(validBody()))).toBe("ACCESS_DENIED:403");
    await pg.exec("UPDATE tenants SET suspended_at = NULL; DELETE FROM tenant_billing_policy");
    expect(await fails(submit(validBody()))).toBe("BILLING_NOT_CONFIGURED:503");
    expect(await count("partner_task_completions")).toBe(0);
  });
  it("tasks Amma pays for take nothing from the partner", async () => {
    await seedActivation(pg, { payer: "amma" });
    const result = await submit(validBody());
    expect(result.status).toBe(202);
    expect(await balance()).toBe("100.0000000");
    expect(await count("billing_events")).toBe(0);
    expect((await q("SELECT payer, billing_event_id FROM wallet_activations"))[0]).toEqual({ payer: "amma", billing_event_id: null });
  });
});

describe("review fixes", () => {
  it("never tells a partner why a user is not eligible: unknown, not allow-listed and not linked look identical", async () => {
    const seen = async (body: unknown) => { try { await submit(body); return "accepted"; } catch (e) { return JSON.stringify({ c: (e as any).code, s: (e as any).status, m: (e as any).message, r: (e as any).retryable }); } };
    const unknown = await seen(validBody({ ammaUserId: 999 }));
    allowed = () => false;
    const notAllowed = await seen(validBody({ idempotencyKey: "idem-key-0076" }));
    allowed = () => true;
    await pg.exec("DELETE FROM tenant_users");
    const notLinked = await seen(validBody({ idempotencyKey: "idem-key-0077" }));
    expect(unknown).toContain("NOT_ELIGIBLE");
    expect(new Set([unknown, notAllowed, notLinked]).size).toBe(1);
  });

  it("only the user's active index-0 wallet is activated (M3)", async () => {
    await pg.exec("UPDATE user_wallets SET is_active = false");
    expect(await fails(submit(validBody()))).toBe("WALLET_NOT_AMMA_HELD:409");
    await pg.exec("UPDATE user_wallets SET is_active = true");
    expect((await submit(validBody())).status).toBe(202);
  });

  it("refuses an uncapped task Amma pays for even when the database check is bypassed (M4)", async () => {
    await seedActivation(pg, { payer: "amma" });
    await pg.exec("ALTER TABLE partner_tasks DROP CONSTRAINT partner_tasks_amma_needs_caps; UPDATE partner_tasks SET total_cap = NULL");
    expect(await fails(submit(validBody()))).toBe("TASK_UNKNOWN:404");
    await pg.exec("UPDATE partner_tasks SET total_cap = 10; ALTER TABLE partner_tasks ADD CONSTRAINT partner_tasks_amma_needs_caps CHECK (payer <> 'amma' OR (daily_cap IS NOT NULL AND total_cap IS NOT NULL))");
    expect((await submit(validBody())).status).toBe(202);
  });

  it("raises the deficit notice after the debit commits, with the new balance, and not for a refusal", async () => {
    notify.mockClear();
    await seedActivation(pg, { balance: "0" });
    await fails(submit(validBody(), { allowDebt: true }));
    expect(notify).toHaveBeenCalledWith(1, "-1.1001000");
    notify.mockClear();
    await seedActivation(pg, { balance: "0" });
    await fails(submit(validBody()));
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("atomicity", () => {
  it("a failure while charging rolls back the completion and the activation row", async () => {
    await pg.exec("ALTER TABLE billing_events ADD CONSTRAINT forced_failure CHECK (false) NOT VALID");
    await expect(submit(validBody())).rejects.toThrow();
    await pg.exec("ALTER TABLE billing_events DROP CONSTRAINT forced_failure");
    for (const t of ["partner_task_completions", "wallet_activations", "billing_events", "audit_logs"]) expect(await count(t)).toBe(0);
    expect(await balance()).toBe("100.0000000");
    // The same request now succeeds: nothing was half-recorded.
    expect((await submit(validBody())).status).toBe(202);
  });
  it("a failure writing the audit row rolls back the charge", async () => {
    await pg.exec("ALTER TABLE audit_logs RENAME TO audit_logs_gone");
    await expect(submit(validBody())).rejects.toThrow();
    await pg.exec("ALTER TABLE audit_logs_gone RENAME TO audit_logs");
    for (const t of ["partner_task_completions", "wallet_activations", "billing_events"]) expect(await count(t)).toBe(0);
    expect(await balance()).toBe("100.0000000");
  });
});

describe("rejection audit", () => {
  it("is written once per tenant and code per minute and carries no request content", async () => {
    for (let i = 0; i < 3; i++) await fails(submit(validBody({ taskKey: "course:nope" })));
    await fails(submit(validBody({ ammaUserId: 999 })));
    const rows = await q("SELECT action, detail FROM audit_logs ORDER BY id");
    expect(rows.map((r) => [r.action, r.detail.code])).toEqual([["activation_rejected", "TASK_UNKNOWN"], ["activation_rejected", "NOT_ELIGIBLE"]]);
    expect(JSON.stringify(rows)).not.toContain("completion-0001");
  });
  it("a broken log never turns a refusal into a 500", async () => {
    await pg.exec("ALTER TABLE audit_logs RENAME TO audit_logs_gone");
    expect(await fails(submit(validBody({ taskKey: "course:nope" })))).toBe("TASK_UNKNOWN:404");
    await pg.exec("ALTER TABLE audit_logs_gone RENAME TO audit_logs");
  });
});

describe("activationView", () => {
  it("is scoped to the tenant", async () => {
    await submit(validBody());
    expect(await activationView(state.db, 1, 1, flags)).not.toBeNull();
    expect(await activationView(state.db, 1, 2, flags)).toBeNull();
    expect(await activationView(state.db, 99, 1, flags)).toBeNull();
  });
  it("maps states to a status and hides refunds behind failed_final", async () => {
    await submit(validBody());
    const status = async (s: string) => { await pg.query("UPDATE wallet_activations SET state=$1, tx_hash='abc'", [s]); return activationView(state.db, 1, 1, flags); };
    expect((await status("submitted"))!.status).toBe("pending");
    expect((await status("failed"))!.status).toBe("pending");
    expect(await status("confirmed")).toMatchObject({ status: "confirmed", chains: [{ txHash: "abc" }] });
    expect(await status("refunded")).toMatchObject({ status: "failed", chains: [{ state: "failed_final" }] });
    expect((await status("failed_final"))!.status).toBe("failed");
    expect((await status("skipped_already_active"))!.status).toBe("skipped");
    expect((await status("submitted"))!.chains[0]).not.toHaveProperty("txHash");
  });
});
