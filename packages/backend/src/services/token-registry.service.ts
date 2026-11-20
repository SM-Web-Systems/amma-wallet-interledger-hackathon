import { eq, and, lt, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db";

export interface TokenEntry {
  jti: string;
  tokenType: string;
  sub: string;
  clientId: string;
  familyId?: string | null;
  codeChallenge?: string | null;
  redirectUri?: string | null;
  scope?: string | null;
  issuedAt: Date;
  expiresAt: Date;
  usedAt?: Date | null;
  revokedAt?: Date | null;
  nonce?: string | null;
}

export async function insertTokenEntry(entry: {
  jti: string;
  tokenType: string;
  sub: string;
  clientId: string;
  familyId?: string | null;
  codeChallenge?: string | null;
  redirectUri?: string | null;
  scope?: string | null;
  issuedAt: Date;
  expiresAt: Date;
  /** OIDC nonce; auth codes only (enforced by token_registry_nonce_shape). */
  nonce?: string | null;
}): Promise<void> {
  await db.insert(schema.tokenRegistry).values(entry);
}

/**
 * Atomically mark a token as used. Uses UPDATE...WHERE...RETURNING to avoid
 * TOCTOU race conditions — the check and mark happen in a single SQL statement.
 * The claim is bound to the calling client and the token type, so one client can
 * never burn another client's code or refresh token.
 * If zero rows are returned, the token was already used, revoked, expired, unknown,
 * or not this caller's. familyId is returned (for replay revocation) only when the
 * token is this caller's and of this type.
 */
export async function markTokenUsed(
  jti: string,
  clientId: string,
  tokenType: "auth_code" | "refresh",
): Promise<{ alreadyUsed: boolean; familyId?: string | null }> {
  const result = await db
    .update(schema.tokenRegistry)
    .set({ usedAt: new Date() })
    .where(and(
      eq(schema.tokenRegistry.jti, jti),
      eq(schema.tokenRegistry.clientId, clientId),
      eq(schema.tokenRegistry.tokenType, tokenType),
      isNull(schema.tokenRegistry.usedAt),
      isNull(schema.tokenRegistry.revokedAt),
      gt(schema.tokenRegistry.expiresAt, new Date()),
    ))
    .returning({ familyId: schema.tokenRegistry.familyId });

  if (result.length > 0) {
    return { alreadyUsed: false, familyId: result[0].familyId };
  }

  // Not claimed. Report a family to revoke only for the caller's own token of this type.
  const entry = await lookupToken(jti);
  if (!entry || entry.clientId !== clientId || entry.tokenType !== tokenType) {
    return { alreadyUsed: true, familyId: null };
  }
  return { alreadyUsed: true, familyId: entry.familyId ?? null };
}

export async function revokeFamily(familyId: string): Promise<number> {
  const result = await db
    .update(schema.tokenRegistry)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.tokenRegistry.familyId, familyId), isNull(schema.tokenRegistry.revokedAt)))
    .returning({ jti: schema.tokenRegistry.jti });

  return result.length;
}

export async function lookupToken(jti: string): Promise<TokenEntry | null> {
  const rows = await db
    .select()
    .from(schema.tokenRegistry)
    .where(eq(schema.tokenRegistry.jti, jti));

  return rows.length > 0 ? (rows[0] as TokenEntry) : null;
}

/**
 * Purge token_registry rows whose expires_at is older than 7 days ago.
 * Rows are retained for 7 days past expiry for incident investigation.
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(schema.tokenRegistry)
    .where(lt(schema.tokenRegistry.expiresAt, cutoff))
    .returning({ jti: schema.tokenRegistry.jti });

  return result.length;
}

