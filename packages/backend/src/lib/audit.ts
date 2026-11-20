import { db, schema } from "../db";

export type AuditAction =
  | "login"
  | "login_failed"
  | "login_locked"
  | "register"
  | "logout"
  | "password_change"
  | "password_reset"
  | "password_reset_request"
  | "email_claim_released"
  | "profile_update"
  | "2fa_enable"
  | "2fa_disable"
  | "signing_mode_change"
  | "transaction_sign"
  | "transaction_submit"
  | "wallet_add"
  | "wallet_remove"
  | "wallet_key_backup_read"
  | "wallet_key_escrow_open"
  | "wallet_key_escrow_save"
  | "wallet_key_escrow_denied"
  | "wallet_custody_sign"
  | "wallet_custody_sign_denied"
  | "custody_onboard"
  | "custody_wallet_added"
  | "custody_wallet_updated"
  | "custody_wallet_imported"
  | "custody_pin_copy_removed"
  | "custody_limit_refused"
  | "custody_send"
  | "custody_stellar_sign"
  | "custody_stellar_token_sign"
  | "custody_lms_claim_signed"
  | "key_recovery_code_sent"
  | "key_recovery_requested"
  | "key_recovery_denied"
  | "key_recovery_cancelled"
  | "key_recovery_completed"
  | "api_key_create"
  | "api_key_revoke"
  | "nft_collection_registered"
  | "nft_transfer"
  | "nft_mint_indexed"
  | "nft_collection_synced"
  | "fiat_stripe_session"
  | "fiat_transak_url"
  | "admin_credit"
  | "admin_suspend"
  | "admin_unsuspend"
  | "admin_create"
  | "admin_deactivate"
  | "admin_reactivate"
  | "admin_billing_policy"
  | "admin_reset_password"
  | "oauth_consent_granted"
  | "oauth_consent_revoked"
  | "activation_requested"
  | "activation_rejected"
  | "activation_funded"
  | "activation_failed"
  | "activation_refunded"
  | "partner_task_changed"
  | "partner_signing_key_added"
  | "partner_signing_key_revoked"
  | "business_wallet_created"
  | "business_wallet_key_open"
  | "fee_address_added"
  | "fee_address_assigned"
  | "business_deposit_credited"
  | "business_deposit_held"
  | "fee_sweep_confirmed"
  | "fee_sweep_failed"
  | "activation_task_created"
  | "activation_task_requirement_set"
  | "business_activations_paused"
  | "business_activations_resumed"
  | "business_daily_cap_changed"
  | "business_floor_hold"
  | "business_floor_cleared";

type AuditOpts = {
  userId?: number;
  detail?: Record<string, any>;
  ip?: string;
  userAgent?: string;
};

/** Like auditLog, but a failed write throws. For actions that must not happen unrecorded. */
export async function auditLogStrict(action: AuditAction, opts: AuditOpts = {}): Promise<void> {
  await db.insert(schema.auditLogs).values({
    userId: opts.userId ?? null,
    action,
    detail: opts.detail ?? {},
    ipAddress: opts.ip ?? null,
    userAgent: opts.userAgent ?? null,
  });
}

export async function auditLog(action: AuditAction, opts: AuditOpts = {}): Promise<void> {
  try {
    await auditLogStrict(action, opts);
  } catch (err) {
    // Never let audit logging crash the app
    console.error("[audit] Failed to write log:", err);
  }
}
