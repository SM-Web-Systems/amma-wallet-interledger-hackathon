import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { canonicalString, signPartnerRequest } from "./signature";
const hashApiKey = (raw: string) => createHash("sha256").update(raw).digest("hex");

export const RAW_KEY = "amma_test_" + "k".repeat(30);
export const KEY_ID = "lms-key-1";
export const ADDRESS = "GBTESTADDRESS000000000000000000000000000000000000000001";
export const ADDRESS_2 = "GBTESTADDRESS000000000000000000000000000000000000000002";

const pair = generateKeyPairSync("ed25519");
export const partnerPrivateKey: KeyObject = pair.privateKey;
export const partnerPublicKeyBase64 = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
export const otherPrivateKey: KeyObject = generateKeyPairSync("ed25519").privateKey;

/** Signed headers exactly as a partner builds them. */
export function signedHeaders(opts: { method: string; path: string; body?: string; key?: string; keyId?: string; at?: Date; privateKey?: KeyObject; signBody?: string }) {
  const timestamp = String(Math.floor((opts.at ?? new Date()).getTime() / 1000));
  const canonical = canonicalString({ method: opts.method, path: opts.path, timestamp, rawBody: opts.signBody ?? opts.body ?? "" });
  return {
    "x-api-key": opts.key ?? RAW_KEY,
    "x-amma-key-id": opts.keyId ?? KEY_ID,
    "x-amma-timestamp": timestamp,
    "x-amma-signature": signPartnerRequest(opts.privateKey ?? partnerPrivateKey, canonical),
    ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
  };
}

const COMPLETED_AT = new Date(Date.now() - 60_000).toISOString();
export const validBody = (over: Record<string, unknown> = {}) => ({
  ammaUserId: 1, taskKey: "course:intro", completionId: "completion-0001", idempotencyKey: "idem-key-0001", completedAt: COMPLETED_AT, ...over,
});

/** Wipes and reseeds one tenant ("LMS", id 1, 100 XLM), one task, two users and user 1's Amma-held wallet. */
export async function seedActivation(pg: PGlite, over: { balance?: string; scopes?: string[]; feeXlm?: string; payer?: string } = {}) {
  await pg.exec("TRUNCATE tenants, tenant_api_keys, tenant_users, billing_events, tenant_billing_policy, partner_signing_keys, partner_activation_settings, partner_tasks, partner_task_completions, wallet_activations, user_wallets, wallet_key_escrow, audit_logs RESTART IDENTITY CASCADE");
  await pg.query("UPDATE users SET is_email_verified = true, signing_mode = 'delegated', created_at = now() - interval '3 days'");
  await pg.query("INSERT INTO tenants (id, slug, name, prepaid_xlm_balance) VALUES (1,'lms','SM Web Systems LMS',$1)", [over.balance ?? "100"]);
  await pg.query("INSERT INTO tenant_billing_policy (tenant_id, new_wallet_platform_fee_xlm) VALUES (1,$1)", [over.feeXlm ?? "0.0001"]);
  await pg.query("INSERT INTO tenant_api_keys (tenant_id, name, key_hash, key_prefix, scopes) VALUES (1,'lms',$1,'amma_test',$2)", [hashApiKey(RAW_KEY), over.scopes ?? ["activation:write", "activation:read"]]);
  await pg.query("INSERT INTO partner_signing_keys (tenant_id, key_id, public_key) VALUES (1,$1,$2)", [KEY_ID, partnerPublicKeyBase64]);
  await pg.query("INSERT INTO partner_activation_settings (tenant_id, enabled, daily_cap, updated_by) VALUES (1,true,50,'test')");
  await pg.query("INSERT INTO partner_tasks (tenant_id, task_key, name, chains, payer, daily_cap, total_cap, created_by) VALUES (1,'course:intro','Intro','{stellar}',$1,$2,$2,'test')", [over.payer ?? "tenant", over.payer === "amma" ? 100 : null]);
  await pg.query("INSERT INTO tenant_users (tenant_id, user_id, registered_via) VALUES (1,1,'sso')");
  await pg.query("INSERT INTO user_wallets (user_id, chain, network, public_key, name, is_active, derivation_index) VALUES (1,'stellar','testnet',$1,'Amma Stellar',true,0)", [ADDRESS]);
  await pg.query("INSERT INTO wallet_key_escrow (user_id, kind, sealed, provider, origin) VALUES (1,'phrase',$1,'local','custody')", ["s".repeat(60)]);
}
