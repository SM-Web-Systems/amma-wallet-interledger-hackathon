import { sql } from 'drizzle-orm';
import { db } from '../db';
import { hashVerificationToken } from './code-hash';

type Executor = {execute: (query: any) => Promise<any>};
type Holder = {
  isEmailVerified?: boolean | null; phoneVerified?: boolean | null; phoneNumber?: string | null;
  twoFaEnabled?: boolean | null; twoFaMethod?: string | null;
};

const rows = (result: any): any[] => result?.rows ?? result ?? [];

export function isUniqueViolation(error: any) {
  return error?.code === '23505' || error?.cause?.code === '23505';
}
export function violatedConstraint(error: any): string {
  return String(error?.constraint_name ?? error?.cause?.constraint_name ?? '');
}

/**
 * An unproven address gives no power over an account that a proven phone owns:
 * no password reset, and no lasting hold on the address. Releasing it leaves the
 * account reachable by phone. Without a proven phone the address may be the only
 * way in, so it stays.
 */
export function ownedByProvenPhone(holder: Holder) {
  return !holder.isEmailVerified && !!holder.phoneVerified && !!holder.phoneNumber;
}

/** A holder signing in with codes sent to the address would be locked out without it. */
export function canReleaseEmail(holder: Holder) {
  return ownedByProvenPhone(holder) && !(holder.twoFaEnabled && holder.twoFaMethod === 'email');
}

async function lockHolder(tx: Executor, email: string): Promise<(Holder & {id: string}) | undefined> {
  const [row] = rows(await tx.execute(sql`SELECT id, is_email_verified, phone_verified, phone_number, two_fa_enabled, two_fa_method
    FROM users WHERE email = ${email} FOR UPDATE`));
  return row && {id: row.id, isEmailVerified: row.is_email_verified, phoneVerified: row.phone_verified, phoneNumber: row.phone_number,
    twoFaEnabled: row.two_fa_enabled, twoFaMethod: row.two_fa_method};
}

async function releaseEmail(tx: Executor, holderId: string) {
  // Unfinished email second factor setup ends with the address, so its code cannot switch it on later.
  await tx.execute(sql`UPDATE users SET email = NULL, is_email_verified = false, updated_at = NOW(),
    two_fa_method = CASE WHEN two_fa_method = 'email' THEN 'none' ELSE two_fa_method END WHERE id = ${holderId}`);
  await tx.execute(sql`UPDATE email_codes SET used = true WHERE user_id = ${holderId} AND used = false`);
  await tx.execute(sql`DELETE FROM email_verification_tokens WHERE user_id = ${holderId}`);
  // A reset link already mailed to that address must not outlive the release.
  await tx.execute(sql`DELETE FROM password_reset_tokens WHERE user_id = ${holderId} AND used_at IS NULL`);
}

export async function pendingEmail(userId: number): Promise<string | null> {
  const [claim] = rows(await db.execute(sql`SELECT email FROM email_verification_tokens
    WHERE user_id = ${userId} AND email IS NOT NULL AND used_at IS NULL AND expires_at > NOW()
    ORDER BY id DESC LIMIT 1`));
  return claim?.email ?? null;
}

export type LinkDescription = {status: 'invalid'} | {status: 'expired'} | {status: 'already'} | {status: 'confirm'; email: string; phoneHint: string | null};

/** Read-only: opening a link, by a person or a mail scanner, changes nothing. */
export async function describeVerificationToken(token: string): Promise<LinkDescription> {
  const [link] = rows(await db.execute(sql`SELECT t.email AS claim_email, t.expires_at, t.used_at, u.email AS account_email, u.phone_number
    FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ${hashVerificationToken(token)} LIMIT 1`));
  if (!link) return {status: 'invalid'};
  if (link.used_at) return {status: 'already'};
  if (new Date(link.expires_at) < new Date()) return {status: 'expired'};
  const email = link.claim_email ?? link.account_email;
  if (!email) return {status: 'invalid'};
  return {status: 'confirm', email, phoneHint: link.phone_number ? String(link.phone_number).slice(-2) : null};
}

export type VerificationResult = {status: 'verified' | 'already' | 'invalid' | 'expired' | 'conflict'; releasedUserId?: number};

/** Every path locks the account before its tokens, then any holder, so concurrent proofs cannot deadlock. */
export async function consumeVerificationToken(token: string): Promise<VerificationResult> {
  const [known] = rows(await db.execute(sql`SELECT user_id FROM email_verification_tokens WHERE token = ${hashVerificationToken(token)} LIMIT 1`));
  if (!known) return {status: 'invalid'};
  try {
    return await db.transaction(async (tx: Executor) => {
      const [user] = rows(await tx.execute(sql`SELECT email FROM users WHERE id = ${known.user_id} FOR UPDATE`));
      const [record] = rows(await tx.execute(sql`SELECT id, email, expires_at, used_at
        FROM email_verification_tokens WHERE token = ${hashVerificationToken(token)} FOR UPDATE`));
      if (!user || !record) return {status: 'invalid'} as VerificationResult;
      if (record.used_at) return {status: 'already'} as VerificationResult;
      if (new Date(record.expires_at) < new Date()) return {status: 'expired'} as VerificationResult;
      const markUsed = () => tx.execute(sql`UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ${record.id}`);
      if (!record.email) {
        if (!user.email) return {status: 'invalid'} as VerificationResult;
        await tx.execute(sql`UPDATE users SET is_email_verified = true, updated_at = NOW() WHERE id = ${known.user_id}`);
        await markUsed();
        return {status: 'verified'} as VerificationResult;
      }
      if (user.email) return {status: 'conflict'} as VerificationResult;
      const holder = await lockHolder(tx, record.email);
      if (holder && !canReleaseEmail(holder)) return {status: 'conflict'} as VerificationResult;
      if (holder) await releaseEmail(tx, holder.id);
      await tx.execute(sql`UPDATE users SET email = ${record.email}, is_email_verified = true, updated_at = NOW() WHERE id = ${known.user_id}`);
      await markUsed();
      await tx.execute(sql`DELETE FROM email_verification_tokens WHERE user_id = ${known.user_id} AND id <> ${record.id}`);
      return {status: 'verified', ...(holder ? {releasedUserId: Number(holder.id)} : {})} as VerificationResult;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return {status: 'conflict'};
    throw error;
  }
}
