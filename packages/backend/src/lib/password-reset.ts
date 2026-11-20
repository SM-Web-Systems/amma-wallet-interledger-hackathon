import { sql } from "drizzle-orm";

type Q = { execute: (query: any) => Promise<unknown> };
const rowsOf = (result: unknown): unknown[] => ((result as any)?.rows ?? result) as unknown[];

/**
 * WA-08: take a reset link. Only one request can win it: the conditional UPDATE takes the row lock,
 * so a parallel request with the same link gets no row back. Run it on the reset transaction, before the password changes.
 */
export async function claimResetToken(q: Q, tokenId: number | string, userId: number): Promise<boolean> {
  // Lock the user first, so two resets for one user (on two different links) run one after the other instead of deadlocking.
  await q.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`);
  const claimed = await q.execute(sql`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ${tokenId} AND used_at IS NULL AND expires_at > NOW() RETURNING id`);
  return rowsOf(claimed).length > 0;
}

/**
 * WA-08: everything a successful password reset writes, on the caller's transaction, so it all commits or none of it does:
 * the new hash, the login lock cleared, every unused reset link voided, every session signed out
 * (refresh tokens, and OAuth refresh tokens and codes) and the password_reset audit row.
 * This is separate from revokeAllUserTokens, which logout and change-password still use unchanged.
 * OAuth access tokens are stateless and stay valid until they expire.
 */
export async function applyPasswordReset(
  q: Q,
  o: { userId: number; passwordHash: string; method: "email" | "sms"; ip?: string; userAgent?: string },
): Promise<void> {
  await q.execute(sql`UPDATE users SET password_hash = ${o.passwordHash}, failed_login_attempts = 0, last_failed_login = NULL, updated_at = NOW() WHERE id = ${o.userId}`);
  await q.execute(sql`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = ${o.userId} AND used_at IS NULL`);
  await q.execute(sql`DELETE FROM refresh_tokens WHERE user_id = ${o.userId}`);
  await q.execute(sql`UPDATE token_registry SET revoked_at = NOW() WHERE sub = ${String(o.userId)} AND revoked_at IS NULL`);
  await q.execute(sql`INSERT INTO audit_logs (user_id, action, detail, ip_address, user_agent)
    VALUES (${o.userId}, 'password_reset', ${JSON.stringify({ method: o.method })}::jsonb, ${o.ip ?? null}, ${o.userAgent ?? null})`);
}
