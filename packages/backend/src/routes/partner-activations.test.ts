import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { activationDatabase } from "../db/migrations/activation.test-support";
import { ADDRESS, KEY_ID, partnerPublicKeyBase64, RAW_KEY, otherPrivateKey, seedActivation, signedHeaders, validBody } from "../modules/activation/activation.test-support";
import { _clearRateLimitWindowsForTest } from "../middleware/tenant-api-key";

const state = vi.hoisted(() => ({ db: undefined as any, userId: 1, frozen: false }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { API_KEYS: ["legacy-env-key-0000000000000000"] } }));
vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("../middleware/auth", () => ({ authMiddleware: async (request: any) => { request.user = { userId: state.userId, type: "user" }; } }));

import { partnerActivationRoutes } from "./partner-activations";
import type { ActivationFlags } from "../lib/activation-flags";

const flags: ActivationFlags = { enabled: true, mainnet: false, network: "testnet", chains: ["stellar"], stellarGrantStroops: 11_000_000n, globalDailyCap: 1000, userDailyCap: 3 };
const PATH = "/api/v1/partner/activations";
let pg: PGlite, app: FastifyInstance;
let paused = false;
const build = async (over: Record<string, unknown> = {}, custodyFlags: any = {}) => {
  const a = Fastify();
  await a.register(partnerActivationRoutes, { flags, custodyFlags, db: state.db, paused: () => paused, frozen: async () => state.frozen, ...over });
  await a.ready();
  return a;
};
const q = async (text: string, params: unknown[] = []) => (await pg.query(text, params)).rows as any[];
const post = (payload: unknown, headers?: Record<string, string>, a = app) => {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return a.inject({ method: "POST", url: PATH, headers: headers ?? signedHeaders({ method: "POST", path: PATH, body: text }), payload: text });
};
const get = (id: string | number, a = app, over: Parameters<typeof signedHeaders>[0] extends infer T ? Partial<T> : never = {}) =>
  a.inject({ method: "GET", url: `${PATH}/${id}`, headers: signedHeaders({ method: "GET", path: `${PATH}/${id}`, ...over }) });
const count = async (t: string) => Number((await q(`SELECT count(*)::int n FROM ${t}`))[0].n);

beforeAll(async () => { pg = await activationDatabase(); state.db = drizzle(pg); app = await build(); }, 60_000);
afterAll(async () => { await app?.close(); await pg?.close(); });
beforeEach(async () => { _clearRateLimitWindowsForTest(); paused = false; state.userId = 1; state.frozen = false; await seedActivation(pg); });

describe("POST /api/v1/partner/activations", () => {
  it("accepts a signed request, answers 202 and charges once", async () => {
    const res = await post(validBody());
    expect(res.statusCode).toBe(202);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ activationId: "1", completionId: "completion-0001", taskKey: "course:intro", status: "pending", chains: [{ chain: "stellar", network: "testnet", address: ADDRESS, state: "reserved" }] });
    expect(await count("billing_events")).toBe(1);
  });

  it("a replay of the very same signed request inside the window returns the stored result, 200, with no second charge", async () => {
    const text = JSON.stringify(validBody());
    const headers = signedHeaders({ method: "POST", path: PATH, body: text });
    const first = await post(text, headers);
    const again = await post(text, headers);
    expect([first.statusCode, again.statusCode]).toEqual([202, 200]);
    expect(again.json()).toEqual(first.json());
    expect(await count("billing_events")).toBe(1);
  });

  it("verifies the signature over the exact bytes sent: spacing and key order are the partner's own", async () => {
    const text = `{ "completedAt": ${JSON.stringify(validBody().completedAt)},\n  "idempotencyKey": "idem-key-0001", "completionId": "completion-0001", "taskKey": "course:intro", "ammaUserId": 1 }`;
    expect((await post(text)).statusCode).toBe(202);
    // The same body re-spaced after signing is a different byte string and fails.
    const signed = signedHeaders({ method: "POST", path: PATH, body: text });
    expect((await post(text.replace("{ ", "{"), signed)).statusCode).toBe(401);
  });

  it("is refused 503 before authentication when the switch is off or the pause file is set", async () => {
    const off = await build({ flags: { ...flags, enabled: false } });
    const res = await off.inject({ method: "POST", url: PATH, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: "ACTIVATION_OFF", retryable: false });
    await off.close();
    paused = true;
    const res2 = await post(validBody(), { "content-type": "application/json" });
    expect(res2.statusCode).toBe(503);
    expect(res2.json().error).toMatchObject({ code: "ACTIVATION_PAUSED", retryable: true });
    expect(await count("partner_task_completions")).toBe(0);
  });

  it("answers authentication failures with the documented error shape and nothing about why", async () => {
    const text = JSON.stringify(validBody());
    const cases: [string, Record<string, string>, number, string][] = [
      ["no key", { "content-type": "application/json" }, 401, "API_KEY_REQUIRED"],
      ["legacy env key", signedHeaders({ method: "POST", path: PATH, body: text, key: "legacy-env-key-0000000000000000" }), 403, "ACCESS_DENIED"],
      ["unknown key", signedHeaders({ method: "POST", path: PATH, body: text, key: "unknown_key_" + "x".repeat(20) }), 403, "ACCESS_DENIED"],
      ["wrong signer", signedHeaders({ method: "POST", path: PATH, body: text, privateKey: otherPrivateKey }), 401, "SIGNATURE_INVALID"],
      ["old timestamp", signedHeaders({ method: "POST", path: PATH, body: text, at: new Date(Date.now() - 400_000) }), 401, "SIGNATURE_INVALID"],
      ["future timestamp", signedHeaders({ method: "POST", path: PATH, body: text, at: new Date(Date.now() + 400_000) }), 401, "SIGNATURE_INVALID"],
      ["signed for the GET", signedHeaders({ method: "GET", path: PATH, body: text }), 401, "SIGNATURE_INVALID"],
      ["signed for another body", signedHeaders({ method: "POST", path: PATH, body: text, signBody: text + " " }), 401, "SIGNATURE_INVALID"],
    ];
    for (const [name, headers, status, code] of cases) {
      const res = await post(text, { ...headers, "content-type": "application/json" });
      expect([name, res.statusCode]).toEqual([name, status]);
      expect(res.json()).toEqual({ error: { code, message: code.replaceAll("_", " ").toLowerCase(), retryable: false, requestId: expect.any(String) } });
    }
    expect(await count("partner_task_completions") + await count("billing_events")).toBe(0);
  });

  it("needs the activation:write scope", async () => {
    await pg.exec("UPDATE tenant_api_keys SET scopes = '{activation:read,sso:verify}'");
    expect((await post(validBody())).json().error.code).toBe("SCOPE_REQUIRED");
  });

  it("maps the eligibility and budget outcomes to their statuses", async () => {
    expect((await post(validBody({ taskKey: "course:nope", idempotencyKey: "idem-key-0002" }))).statusCode).toBe(404);
    expect((await post(validBody({ ammaUserId: 999, idempotencyKey: "idem-key-0003" }))).json().error.code).toBe("NOT_ELIGIBLE");
    await post(validBody());
    const mismatch = await post(validBody({ taskKey: "course:other" }));
    expect([mismatch.statusCode, mismatch.json().error.code]).toEqual([409, "IDEMPOTENCY_MISMATCH"]);
    await pg.exec("UPDATE tenants SET prepaid_xlm_balance = 0");
    await pg.exec("DELETE FROM wallet_activations; DELETE FROM partner_task_completions");
    const broke = await post(validBody());
    expect([broke.statusCode, broke.json().error.code]).toEqual([402, "BUDGET_EXHAUSTED"]);
  });

  it("tells a capped partner when to retry", async () => {
    await pg.exec("UPDATE partner_activation_settings SET daily_cap = 0");
    const res = await post(validBody());
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("3600");
    expect(res.json().error).toMatchObject({ code: "CAP_REACHED", retryable: true, retryAfter: 3600 });
  });

  it("refuses malformed bodies: not JSON, wrong type, unknown field, too large", async () => {
    expect((await post("{not json", signedHeaders({ method: "POST", path: PATH, body: "{not json" }))).statusCode).toBe(400);
    expect((await post("[]")).json().error.code).toBe("INVALID_REQUEST");
    expect((await post({ ...validBody(), extra: true })).json().error.code).toBe("INVALID_REQUEST");
    const big = JSON.stringify({ ...validBody(), pad: "x".repeat(70_000) });
    const res = await post(big);
    expect([res.statusCode, res.json().error.code]).toEqual([413, "REQUEST_TOO_LARGE"]);
    const form = await app.inject({ method: "POST", url: PATH, headers: { "content-type": "text/plain", ...signedHeaders({ method: "POST", path: PATH, body: "x" }) }, payload: "x" });
    expect(form.statusCode).toBe(400);
    expect(await count("partner_task_completions")).toBe(0);
  });

  it("never leaks a database error", async () => {
    const broken = await build({ db: { execute: async () => { throw new Error("password=hunter2 host=db.internal"); }, transaction: async () => { throw new Error("password=hunter2"); } } });
    const res = await broken.inject({ method: "POST", url: PATH, headers: signedHeaders({ method: "POST", path: PATH, body: "{}" }), payload: "{}" });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain("hunter2");
    expect(res.json().error).toMatchObject({ code: "AUTH_UNAVAILABLE", retryable: true });
    await broken.close();
  });

  describe("mainnet allow-list", () => {
    it("refuses a user who is not on the list with the same generic answer, and serves a listed one", async () => {
      const mainnetFlags = { ...flags, mainnet: true, network: "public" as const };
      await pg.exec("UPDATE user_wallets SET network = 'public'");
      const listed = await build({ flags: mainnetFlags }, { mainnet: true, mainnetUserIds: new Set([1]) });
      const unlisted = await build({ flags: mainnetFlags }, { mainnet: true, mainnetUserIds: new Set([2]) });
      const empty = await build({ flags: mainnetFlags }, { mainnet: true, mainnetUserIds: new Set() });
      expect((await post(validBody({ idempotencyKey: "idem-key-0009" }), undefined, unlisted)).json().error.code).toBe("NOT_ELIGIBLE");
      expect((await post(validBody({ idempotencyKey: "idem-key-0009" }), undefined, empty)).statusCode).toBe(403);
      expect(await count("partner_task_completions")).toBe(0);
      expect((await post(validBody(), undefined, listed)).statusCode).toBe(202);
      await Promise.all([listed.close(), unlisted.close(), empty.close()]);
    });
  });
});

describe("GET /api/v1/partner/activations/:activationId", () => {
  it("returns the current state to the tenant that made it, with the hash once confirmed", async () => {
    await post(validBody());
    expect((await get(1)).json()).toMatchObject({ activationId: "1", status: "pending", chains: [{ state: "reserved" }] });
    await pg.exec("UPDATE wallet_activations SET state='confirmed', tx_hash='abc123'");
    const res = await get(1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "confirmed", chains: [{ chain: "stellar", state: "confirmed", txHash: "abc123" }] });
  });
  it("is 404 for unknown, malformed and other tenants' ids, and never discloses which", async () => {
    await post(validBody());
    for (const id of ["999", "0", "-1", "abc", "1.5", "1".repeat(20)]) expect((await get(id)).statusCode).toBe(404);
    await pg.exec(`INSERT INTO tenants (id, slug, name) VALUES (2,'two','Two');
      INSERT INTO tenant_api_keys (tenant_id, name, key_hash, key_prefix, scopes) VALUES (2,'k2', encode(sha256(convert_to('${"o".repeat(30)}_second_key','UTF8')),'hex'), 'o', '{activation:read}');
      INSERT INTO partner_signing_keys (tenant_id, key_id, public_key) VALUES (2,'${KEY_ID}','${partnerPublicKeyBase64}');
      INSERT INTO partner_activation_settings (tenant_id, enabled, updated_by) VALUES (2,true,'t')`);
    const other = await get(1, app, { key: `${"o".repeat(30)}_second_key` });
    expect([other.statusCode, other.json().error.code]).toEqual([404, "ACTIVATION_NOT_FOUND"]);
  });
  it("needs the read scope and a valid signature, and works while paused", async () => {
    await post(validBody());
    await pg.exec("UPDATE tenant_api_keys SET scopes = '{activation:write}'");
    expect((await get(1)).json().error.code).toBe("SCOPE_REQUIRED");
    await pg.exec("UPDATE tenant_api_keys SET scopes = '{activation:read}'");
    expect((await get(1, app, { privateKey: otherPrivateKey })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `${PATH}/1`, headers: { "x-api-key": RAW_KEY } })).statusCode).toBe(401);
    paused = true;
    expect((await get(1)).statusCode).toBe(200);
  });
  it("is off when the switch is off", async () => {
    const off = await build({ flags: { ...flags, enabled: false } });
    expect((await get(1, off)).statusCode).toBe(503);
    await off.close();
  });
});

describe("GET /api/v1/custody/activation (the user's own state)", () => {
  const mine = async (a = app) => (await a.inject({ method: "GET", url: "/api/v1/custody/activation" }));
  const stateOf = async () => (await mine()).json().wallets[0];
  it("reports not activated, activating, delayed, failed and active", async () => {
    expect(await stateOf()).toEqual({ chain: "stellar", network: "testnet", address: ADDRESS, state: "not_activated" });
    await post(validBody());
    expect((await stateOf()).state).toBe("activating");
    await pg.exec("UPDATE wallet_activations SET state='submitted'");
    expect((await stateOf()).state).toBe("activating");
    await pg.exec("UPDATE wallet_activations SET state='failed'");
    expect((await stateOf()).state).toBe("delayed");
    await pg.exec("UPDATE wallet_activations SET state='refunded'");
    expect((await stateOf()).state).toBe("failed");
    await pg.exec("UPDATE wallet_activations SET state='skipped_already_active'");
    expect((await stateOf())).toEqual({ chain: "stellar", network: "testnet", address: ADDRESS, state: "active" });
    await pg.exec("UPDATE wallet_activations SET state='confirmed', tx_hash='abc', confirmed_at='2026-11-16T10:00:00Z'");
    expect(await stateOf()).toMatchObject({ state: "active", activatedBy: "SM Web Systems LMS", txHash: "abc" });
    expect((await stateOf()).activatedAt).toBeTruthy();
  });
  it("shows only the caller's own wallet and rows", async () => {
    await post(validBody());
    await pg.exec("UPDATE wallet_activations SET state='confirmed'");
    state.userId = 2;
    expect((await mine()).json()).toEqual({ wallets: [] });
  });
  it("reports only the user's active index-0 wallet", async () => {
    await pg.exec("UPDATE user_wallets SET is_active = false");
    expect((await mine()).json()).toEqual({ wallets: [] });
  });
  it("is 503 when off and 403 for a user outside the mainnet allow-list", async () => {
    const off = await build({ flags: { ...flags, enabled: false } });
    expect((await mine(off)).statusCode).toBe(503);
    const gated = await build({}, { mainnet: true, mainnetUserIds: new Set([5]) });
    expect((await mine(gated)).statusCode).toBe(403);
    await Promise.all([off.close(), gated.close()]);
  });
  it("cannot start an activation: it is read-only", async () => {
    expect((await app.inject({ method: "POST", url: "/api/v1/custody/activation", payload: validBody() })).statusCode).toBe(404);
    expect(await count("wallet_activations")).toBe(0);
  });
});
