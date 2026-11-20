import crypto from "node:crypto";
import speakeasy from "speakeasy";
import { and, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "../db";
import { decryptTotpSecret } from "./totp-crypto";
import { checkStaticCode, hashEmailCode } from "./code-hash";
import { timingSafeCompare } from "./timing-safe";

/** The second-factor fields of a user row, as the users table stores them. */
export interface SecondFactorUser {
  id: number;
  email: string | null;
  twoFaEnabled: boolean | null;
  twoFaMethod: string | null;
  twoFaSecret: string | null;
  twoFaBackupCodes: string | null;
  twoFaStaticCode: string | null;
}

export const secondFactorColumns = {
  id: schema.users.id,
  email: schema.users.email,
  twoFaEnabled: schema.users.twoFaEnabled,
  twoFaMethod: schema.users.twoFaMethod,
  twoFaSecret: schema.users.twoFaSecret,
  twoFaBackupCodes: schema.users.twoFaBackupCodes,
  twoFaStaticCode: schema.users.twoFaStaticCode,
};

export const EMAIL_CODE_MINUTES = 10;

export const secondFactorMethod = (user: SecondFactorUser): string => user.twoFaMethod || "totp";

/** Issues a one-time email code for this purpose (the "email" 2FA method). Earlier unused codes of the same purpose stop working. */
export async function issueEmailCode(userId: number, purpose: string): Promise<string> {
  const code = crypto.randomInt(100000, 1000000).toString();
  await db.execute(sql`UPDATE email_codes SET used = true WHERE user_id = ${userId} AND type = ${purpose} AND used = false`);
  await db.insert(schema.emailCodes).values({
    userId, code: hashEmailCode(code), type: purpose, expiresAt: new Date(Date.now() + EMAIL_CODE_MINUTES * 60 * 1000),
  });
  return code;
}

/**
 * Checks a second-factor code for an enrolled user, with the same rules as sign-in: the user's method
 * (authenticator, email code of this purpose, or static code), and backup codes as a fallback for
 * every method but static. A used email or backup code is consumed. Returns false for anything else.
 */
export async function verifySecondFactor(user: SecondFactorUser, token: unknown, purpose: string): Promise<boolean> {
  if (typeof token !== "string" || token.length > 64) return false;
  const clean = token.replace(/\s/g, "");
  const method = secondFactorMethod(user);

  if (method === "totp" && /^\d{6}$/.test(clean) && user.twoFaSecret) {
    if (speakeasy.totp.verify({ secret: decryptTotpSecret(user.twoFaSecret), encoding: "base32", token: clean, window: 1 })) return true;
  } else if (method === "email" && /^\d{6}$/.test(clean)) {
    const used = await db.update(schema.emailCodes).set({ used: true })
      .where(and(
        eq(schema.emailCodes.userId, user.id),
        eq(schema.emailCodes.code, hashEmailCode(clean)),
        eq(schema.emailCodes.type, purpose),
        eq(schema.emailCodes.used, false),
        gt(schema.emailCodes.expiresAt, new Date()),
      ))
      .returning({ id: schema.emailCodes.id });
    if (used.length > 0) return true;
  } else if (method === "static" && /^\d{6}$/.test(clean)) {
    if (checkStaticCode(user.twoFaStaticCode, clean, user.id).valid) return true;
  }

  if (method !== "static" && clean.length === 8) {
    const hashed = crypto.createHash("sha256").update(clean.toUpperCase()).digest("hex");
    const stored: string[] = JSON.parse(user.twoFaBackupCodes || "[]");
    const idx = stored.findIndex((c) => timingSafeCompare(c, hashed));
    if (idx !== -1) {
      stored.splice(idx, 1);
      // Only consumes from the exact list that was checked, so a parallel use of the same code cannot both pass.
      const updated = await db.update(schema.users).set({ twoFaBackupCodes: JSON.stringify(stored) })
        .where(and(eq(schema.users.id, user.id), eq(schema.users.twoFaBackupCodes, user.twoFaBackupCodes!)))
        .returning({ id: schema.users.id });
      return updated.length > 0;
    }
  }
  return false;
}
