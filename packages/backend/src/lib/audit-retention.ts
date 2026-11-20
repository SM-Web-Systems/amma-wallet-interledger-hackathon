import { sql } from "drizzle-orm";

// Custody and recovery evidence: the key-use activity list and the wrong-password limiter read these,
// and they are the record of every time a key was used. Exempt from the purge until the owner sets a retention policy.
export const RETAINED_AUDIT_ACTIONS = [
  "wallet_key_escrow_open",
  "wallet_key_escrow_save",
  "wallet_key_escrow_denied",
  "wallet_custody_sign",
  "wallet_custody_sign_denied",
  "custody_stellar_sign",
  "custody_stellar_token_sign",
  "custody_onboard",
  "custody_wallet_added",
  "custody_wallet_updated",
  "custody_wallet_imported",
  "custody_pin_copy_removed",
  "custody_limit_refused",
  "custody_send",
  "custody_lms_claim_signed",
  "key_recovery_code_sent",
  "key_recovery_requested",
  "key_recovery_denied",
  "key_recovery_cancelled",
  "key_recovery_completed",
  "wallet_key_backup_read",
  // Task-gated activation: every grant and refund is financial evidence.
  "activation_requested",
  "activation_rejected",
  "activation_funded",
  "activation_failed",
  "activation_refunded",
  "partner_task_changed",
  "partner_signing_key_added",
  "partner_signing_key_revoked",
] as const;

export async function purgeOldAuditLogs(db: { execute: (q: any) => Promise<unknown> }, now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const retained = sql.join(RETAINED_AUDIT_ACTIONS.map((a) => sql`${a}`), sql`, `);
  await db.execute(
    sql`DELETE FROM audit_logs WHERE created_at < ${cutoff}::timestamptz AND action NOT IN (${retained})`,
  );
}
