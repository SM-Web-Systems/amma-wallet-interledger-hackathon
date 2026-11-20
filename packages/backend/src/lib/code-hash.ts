import crypto from "node:crypto";
import { config } from "../config";
import { timingSafeCompare } from "./timing-safe";

// Login codes and email verification tokens are stored as keyed hashes (G-06),
// so a copy of the database does not hold anything that can be used to sign in
// or to verify an address. The key comes from CODE_HASH_KEY when the deployment
// sets one, and otherwise from TOTP_ENCRYPTION_KEY, which the server already
// requires at start. Each purpose gets its own derived key.

function baseKey(): string {
  const key = config.CODE_HASH_KEY || config.TOTP_ENCRYPTION_KEY;
  if (!key) throw new Error("No key available to hash login codes");
  return key;
}

function digest(purpose: string, value: string): string {
  const derived = crypto.createHmac("sha256", baseKey()).update(`amma-code-hash:v1:${purpose}`).digest();
  return crypto.createHmac("sha256", derived).update(value).digest("hex");
}

export function hashEmailCode(code: string): string {
  return digest("email-code", code);
}

export function hashVerificationToken(token: string): string {
  return digest("verification-token", token);
}

// The static 2FA code is six digits, so a plain SHA-256 of it can be reversed from a database copy in
// moments. New codes are stored as "h1:" plus a keyed hash. A code stored the old way keeps working, and
// the caller replaces it with the keyed hash the first time it is used, so nobody is locked out by this change.
const STATIC_PREFIX = "h1:";

// The user's id is part of what is hashed, so two people with the same code have different stored values and
// a database copy does not show who uses a common code.
export function hashStaticCode(code: string, userId: number | string): string {
  return STATIC_PREFIX + digest("static-2fa", `${userId}:${code}`);
}

export function checkStaticCode(stored: string | null | undefined, input: string, userId: number | string): { valid: boolean; upgrade: string | null } {
  if (!stored) return { valid: false, upgrade: null };
  if (stored.startsWith(STATIC_PREFIX)) {
    return { valid: timingSafeCompare(stored, hashStaticCode(input, userId)), upgrade: null };
  }
  const old = crypto.createHash("sha256").update(input).digest("hex");
  return timingSafeCompare(stored, old) ? { valid: true, upgrade: hashStaticCode(input, userId) } : { valid: false, upgrade: null };
}
