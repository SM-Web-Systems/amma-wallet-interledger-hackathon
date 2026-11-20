import { sql } from "drizzle-orm";
import { hashApiKey, checkAndCountRateLimit } from "../../middleware/tenant-api-key";
import { ActivationError, iso, rowsOf, type Executor } from "./errors";
import { canonicalString, TIMESTAMP_WINDOW_SECONDS, verifyPartnerSignature } from "./signature";

export type ActivationScope = "activation:write" | "activation:read";
export interface PartnerContext { tenantId: number; tenantName: string; apiKeyId: number; signingKeyId: number; dailyCap: number; allowDebt: boolean }
export interface PartnerRequest { headers: Record<string, string | string[] | undefined>; method: string; path: string; rawBody: Buffer }

const header = (h: PartnerRequest["headers"], name: string): string | undefined => (typeof h[name] === "string" ? (h[name] as string) : undefined);

/**
 * Strict partner guard, the same shape as requireXrplApplication: a tenant API key from the database only (the legacy API_KEYS
 * env bridge is never consulted), an active and unsuspended tenant, the scope, then an Ed25519 signature over the exact bytes
 * received and a timestamp within +-300 s. Every failure is a short code; nothing about the key, tenant or signer is echoed.
 */
export async function authenticatePartner(db: Executor, request: PartnerRequest, scope: ActivationScope, now: Date = new Date()): Promise<PartnerContext> {
  const rawKey = header(request.headers, "x-api-key");
  if (!rawKey || rawKey.length < 16 || rawKey.length > 256 || /\s/.test(rawKey)) throw new ActivationError("API_KEY_REQUIRED", 401);
  let key;
  try {
    key = rowsOf<{ tenant_id: number; name: string; key_id: number; scopes: string[]; lim: number }>(await db.execute(sql`
      SELECT t.id AS tenant_id, t.name, k.id AS key_id, k.scopes, k.rate_limit_per_minute AS lim
      FROM tenant_api_keys k JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = ${hashApiKey(rawKey)} AND k.is_active = true AND (k.expires_at IS NULL OR k.expires_at > ${iso(now)}::timestamptz)
        AND t.is_active = true AND t.suspended_at IS NULL LIMIT 1`))[0];
  } catch { throw new ActivationError("AUTH_UNAVAILABLE", 503, true); }
  if (!key) throw new ActivationError("ACCESS_DENIED", 403);
  if (!Array.isArray(key.scopes) || !key.scopes.includes(scope)) throw new ActivationError("SCOPE_REQUIRED", 403);

  const keyId = header(request.headers, "x-amma-key-id"), timestamp = header(request.headers, "x-amma-timestamp"), signature = header(request.headers, "x-amma-signature");
  if (!keyId || !timestamp || !signature || !/^[A-Za-z0-9_-]{4,64}$/.test(keyId) || !/^\d{10}$/.test(timestamp)) throw new ActivationError("SIGNATURE_INVALID", 401);
  if (Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp)) > TIMESTAMP_WINDOW_SECONDS) throw new ActivationError("SIGNATURE_INVALID", 401);
  let signing;
  try {
    signing = rowsOf<{ id: number; public_key: string }>(await db.execute(sql`
      SELECT id, public_key FROM partner_signing_keys WHERE tenant_id = ${Number(key.tenant_id)} AND key_id = ${keyId}
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${iso(now)}::timestamptz) LIMIT 1`))[0];
  } catch { throw new ActivationError("AUTH_UNAVAILABLE", 503, true); }
  const canonical = canonicalString({ method: request.method, path: request.path, timestamp, rawBody: request.rawBody });
  if (!signing || !verifyPartnerSignature(signing.public_key, signature, canonical)) throw new ActivationError("SIGNATURE_INVALID", 401);

  // Counted only once the signature is valid, so forged calls cannot burn a partner's allowance.
  if (!checkAndCountRateLimit(Number(key.key_id), Number(key.lim) > 0 ? Number(key.lim) : 60)) throw new ActivationError("RATE_LIMITED", 429, true);

  let settings;
  try { settings = rowsOf<{ enabled: boolean; daily_cap: number; allow_debt: boolean }>(await db.execute(sql`SELECT enabled, daily_cap, allow_debt FROM partner_activation_settings WHERE tenant_id = ${Number(key.tenant_id)}`))[0]; }
  catch { throw new ActivationError("AUTH_UNAVAILABLE", 503, true); }
  if (!settings?.enabled) throw new ActivationError("ACTIVATION_NOT_ENABLED", 403);
  return { tenantId: Number(key.tenant_id), tenantName: key.name, apiKeyId: Number(key.key_id), signingKeyId: Number(signing.id), dailyCap: Number(settings.daily_cap), allowDebt: settings.allow_debt === true };
}
