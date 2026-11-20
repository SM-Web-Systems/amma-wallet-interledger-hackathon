import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { config } from "../config";
import { db } from "../db";
import { refreshTokens } from "../db/schema";
import { eq, and, gt } from "drizzle-orm";

export interface JwtPayload {
  userId: number;
  email: string | null;
  type?: string;
}

const SALT_ROUNDS = 12;

/**
 * One-way SHA-256 hash for high-entropy tokens (refresh tokens, reset tokens).
 * Unlike bcrypt, SHA-256 is deterministic — enabling direct DB lookup by hash.
 * Safe for tokens with >= 128 bits of entropy (JWTs, randomBytes(32)).
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign({ ...payload, type: "user" }, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN, // number (seconds) — no type error
  });
}

export function generateRefreshToken(payload: JwtPayload): string {
  // A fresh identifier prevents duplicate hashes for logins/rotations in the same second.
  return jwt.sign(payload, config.JWT_REFRESH_SECRET, {
    jwtid: crypto.randomUUID(),
    expiresIn: config.JWT_REFRESH_EXPIRES_IN,
  });
}

/**
 * Verifies a user access token. Only tokens this server issued through
 * generateAccessToken are accepted: HS256, `type: "user"` and a positive
 * integer userId. Any other token type (admin, refresh, SSO, a future
 * service or impersonation token) is rejected here, so every caller gets an
 * allowlist rather than a blocklist.
 */
export function verifyAccessToken(token: string): JwtPayload {
  const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
  if (
    typeof payload !== "object" || payload === null ||
    (payload as JwtPayload).type !== "user" ||
    !Number.isSafeInteger((payload as JwtPayload).userId) ||
    (payload as JwtPayload).userId <= 0
  ) {
    throw new Error("Not a user access token");
  }
  return payload as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, config.JWT_REFRESH_SECRET) as JwtPayload;
}

export async function storeRefreshToken(
  userId: number,
  token: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + config.JWT_REFRESH_EXPIRES_IN * 1000);
  const tokenHash = hashToken(token);
  await db.insert(refreshTokens).values({ userId, token: tokenHash, expiresAt });
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db.delete(refreshTokens).where(eq(refreshTokens.token, tokenHash));
}

export async function revokeAllUserTokens(userId: number): Promise<void> {
  await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
}

export async function validateStoredRefreshToken(
  token: string,
): Promise<boolean> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.token, tokenHash),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
