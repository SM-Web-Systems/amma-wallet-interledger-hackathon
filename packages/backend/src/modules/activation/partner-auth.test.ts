import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { activationDatabase } from "../../db/migrations/activation.test-support";
import { RAW_KEY, KEY_ID, otherPrivateKey, seedActivation, signedHeaders } from "./activation.test-support";
import { _clearRateLimitWindowsForTest } from "../../middleware/tenant-api-key";

const state = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../../db", async () => ({ get db() { return state.db; }, schema: await import("../../db/schema") }));
vi.mock("../../config", () => ({ config: { API_KEYS: ["legacy-env-key-0000000000000000"] } }));

import { authenticatePartner, type PartnerRequest } from "./partner-auth";
import { canonicalString, signPartnerRequest, verifyPartnerSignature } from "./signature";
import { partnerPublicKeyBase64, partnerPrivateKey } from "./activation.test-support";

let pg: PGlite;
const BODY = JSON.stringify({ hello: "world" });
const req = (over: Partial<PartnerRequest> & { headers?: Record<string, string> } = {}, signed: Parameters<typeof signedHeaders>[0] = { method: "POST", path: "/api/v1/partner/activations", body: BODY }): PartnerRequest =>
  ({ method: "POST", path: "/api/v1/partner/activations", rawBody: Buffer.from(BODY), headers: signedHeaders(signed), ...over });
const run = (r: PartnerRequest, scope: "activation:write" | "activation:read" = "activation:write", now = new Date()) => authenticatePartner(state.db, r, scope, now);
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return `${(e as any).code}:${(e as any).status}`; } };

beforeAll(async () => { pg = await activationDatabase(); state.db = drizzle(pg); }, 60_000);
afterAll(async () => { await pg?.close(); });
beforeEach(async () => { _clearRateLimitWindowsForTest(); await seedActivation(pg); });

describe("signature primitives", () => {
  it("round-trips, and rejects a changed body, path, method, timestamp or key", () => {
    const c = canonicalString({ method: "post", path: "/p", timestamp: "1700000000", rawBody: "{}" });
    expect(c.split("\n")).toEqual(["amma-partner-v1", "POST", "/p", "1700000000", expect.stringMatching(/^[a-f0-9]{64}$/)]);
    const sig = signPartnerRequest(partnerPrivateKey, c);
    expect(verifyPartnerSignature(partnerPublicKeyBase64, sig, c)).toBe(true);
    for (const other of [{ rawBody: "{ }" }, { path: "/q" }, { method: "GET" }, { timestamp: "1700000001" }])
      expect(verifyPartnerSignature(partnerPublicKeyBase64, sig, canonicalString({ method: "POST", path: "/p", timestamp: "1700000000", rawBody: "{}", ...other }))).toBe(false);
    expect(verifyPartnerSignature(partnerPublicKeyBase64, signPartnerRequest(otherPrivateKey, c), c)).toBe(false);
    for (const junk of ["", "ed25519=", "rsa=abc", `ed25519=${"A".repeat(86)}==`, sig.replace("ed25519=", "")]) expect(verifyPartnerSignature(partnerPublicKeyBase64, junk, c)).toBe(false);
    expect(verifyPartnerSignature("not-a-key", sig, c)).toBe(false);
  });
});

describe("authenticatePartner", () => {
  it("accepts a valid key and signature and returns the tenant, key ids and settings", async () => {
    expect(await run(req())).toMatchObject({ tenantId: 1, tenantName: "SM Web Systems LMS", dailyCap: 50, allowDebt: false });
  });

  it("refuses a missing, short or unknown API key, and never accepts the legacy env key", async () => {
    expect(await code(run(req({ headers: { ...signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY }), "x-api-key": "" } })))).toBe("API_KEY_REQUIRED:401");
    expect(await code(run(req({ headers: { ...signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY }), "x-api-key": "short" } })))).toBe("API_KEY_REQUIRED:401");
    expect(await code(run(req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY, key: "unknown_key_" + "x".repeat(20) }) })))).toBe("ACCESS_DENIED:403");
    expect(await code(run(req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY, key: "legacy-env-key-0000000000000000" }) })))).toBe("ACCESS_DENIED:403");
  });

  it("refuses an inactive or expired key and an inactive or suspended tenant", async () => {
    await pg.exec("UPDATE tenant_api_keys SET is_active = false");
    expect(await code(run(req()))).toBe("ACCESS_DENIED:403");
    await pg.exec("UPDATE tenant_api_keys SET is_active = true, expires_at = now() - interval '1 minute'");
    expect(await code(run(req()))).toBe("ACCESS_DENIED:403");
    await pg.exec("UPDATE tenant_api_keys SET expires_at = NULL; UPDATE tenants SET suspended_at = now()");
    expect(await code(run(req()))).toBe("ACCESS_DENIED:403");
    await pg.exec("UPDATE tenants SET suspended_at = NULL, is_active = false");
    expect(await code(run(req()))).toBe("ACCESS_DENIED:403");
  });

  it("needs the scope, the right one for the route", async () => {
    await pg.exec("UPDATE tenant_api_keys SET scopes = '{activation:read}'");
    expect(await code(run(req()))).toBe("SCOPE_REQUIRED:403");
    expect(await code(run(req(), "activation:read"))).toBe("ok");
    await pg.exec("UPDATE tenant_api_keys SET scopes = '{sso:verify}'");
    expect(await code(run(req(), "activation:read"))).toBe("SCOPE_REQUIRED:403");
  });

  it("refuses missing, malformed, forged and wrong-body signatures", async () => {
    const good = signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY });
    for (const drop of ["x-amma-key-id", "x-amma-timestamp", "x-amma-signature"]) {
      const { [drop as keyof typeof good]: _gone, ...rest } = good;
      expect(await code(run(req({ headers: rest as any })))).toBe("SIGNATURE_INVALID:401");
    }
    expect(await code(run(req({ headers: { ...good, "x-amma-signature": "ed25519=nope" } })))).toBe("SIGNATURE_INVALID:401");
    expect(await code(run(req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY, privateKey: otherPrivateKey }) })))).toBe("SIGNATURE_INVALID:401");
    // Signed over a different body than the one received.
    expect(await code(run(req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY, signBody: '{"hello":"mars"}' }) })))).toBe("SIGNATURE_INVALID:401");
    // Signed for another path or method.
    expect(await code(run(req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/other", body: BODY }) })))).toBe("SIGNATURE_INVALID:401");
    expect(await code(run(req({ method: "GET", headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY }) })))).toBe("SIGNATURE_INVALID:401");
  });

  it("enforces the +-300 s window on both sides", async () => {
    const now = new Date();
    const at = (s: number) => req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY, at: new Date(now.getTime() + s * 1000) }) });
    expect(await code(run(at(-299), "activation:write", now))).toBe("ok");
    expect(await code(run(at(299), "activation:write", now))).toBe("ok");
    expect(await code(run(at(-301), "activation:write", now))).toBe("SIGNATURE_INVALID:401");
    expect(await code(run(at(301), "activation:write", now))).toBe("SIGNATURE_INVALID:401");
    expect(await code(run(req({ headers: { ...signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY }), "x-amma-timestamp": "12.5" } })))).toBe("SIGNATURE_INVALID:401");
  });

  it("refuses an unknown, revoked or expired signing key, and one that belongs to another tenant", async () => {
    expect(await code(run(req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY, keyId: "no-such-key" }) })))).toBe("SIGNATURE_INVALID:401");
    await pg.exec("UPDATE partner_signing_keys SET revoked_at = now()");
    expect(await code(run(req()))).toBe("SIGNATURE_INVALID:401");
    await pg.exec("UPDATE partner_signing_keys SET revoked_at = NULL, expires_at = now() - interval '1 second'");
    expect(await code(run(req()))).toBe("SIGNATURE_INVALID:401");
    await pg.exec(`UPDATE partner_signing_keys SET expires_at = NULL; INSERT INTO tenants (id, slug, name) VALUES (2,'other','Other')`);
    await pg.exec("UPDATE partner_signing_keys SET tenant_id = 2");
    expect(await code(run(req()))).toBe("SIGNATURE_INVALID:401");
  });

  it("allows two active signing keys for rotation", async () => {
    await pg.query("INSERT INTO partner_signing_keys (tenant_id, key_id, public_key) VALUES (1,'lms-key-2',$1)", [partnerPublicKeyBase64]);
    expect(await code(run(req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY, keyId: "lms-key-2" }) })))).toBe("ok");
    expect(KEY_ID).toBe("lms-key-1");
  });

  it("needs activation switched on for the tenant", async () => {
    await pg.exec("UPDATE partner_activation_settings SET enabled = false");
    expect(await code(run(req()))).toBe("ACTIVATION_NOT_ENABLED:403");
    await pg.exec("DELETE FROM partner_activation_settings");
    expect(await code(run(req()))).toBe("ACTIVATION_NOT_ENABLED:403");
  });

  it("rate limits per key", async () => {
    await pg.exec("UPDATE tenant_api_keys SET rate_limit_per_minute = 2");
    expect(await code(run(req()))).toBe("ok");
    expect(await code(run(req()))).toBe("ok");
    expect(await code(run(req()))).toBe("RATE_LIMITED:429");
  });

  it("forged or unsigned calls never use up the key's allowance", async () => {
    await pg.exec("UPDATE tenant_api_keys SET rate_limit_per_minute = 2");
    const forged = () => req({ headers: signedHeaders({ method: "POST", path: "/api/v1/partner/activations", body: BODY, privateKey: otherPrivateKey }) });
    for (let i = 0; i < 6; i++) expect(await code(run(forged()))).toBe("SIGNATURE_INVALID:401");
    expect(await code(run(req()))).toBe("ok");
    expect(await code(run(req()))).toBe("ok");
    expect(await code(run(req()))).toBe("RATE_LIMITED:429");
  });

  it("reports a database failure as retryable and unavailable, never as a refusal", async () => {
    const broken = { execute: async () => { throw new Error("connection refused host=secret-db"); } };
    const r = req();
    let err: any;
    try { await authenticatePartner(broken as any, r, "activation:write"); } catch (e) { err = e; }
    expect(err).toMatchObject({ code: "AUTH_UNAVAILABLE", status: 503, retryable: true });
    expect(JSON.stringify(err)).not.toContain("secret-db");
    expect(RAW_KEY.length).toBeGreaterThan(16);
  });
});
