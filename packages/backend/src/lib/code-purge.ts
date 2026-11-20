import { sql } from "drizzle-orm";

// G-06: login codes and verification tokens do not live forever. Anything that is not a 64 character hash is
// a row written before codes were hashed, and goes at once. Hashed rows go a day after they expire or are used.
const HASH_ONLY = "^[0-9a-f]{64}$";

type Executor = { execute: (query: any) => Promise<any> };

export async function purgeCodesAndTokens(db: Executor): Promise<{ codes: number; tokens: number }> {
  const count = (result: any) => Number(result?.rowCount ?? result?.count ?? (result?.rows ?? result ?? []).length ?? 0);
  const codes = await db.execute(sql`DELETE FROM email_codes
    WHERE code !~ ${HASH_ONLY} OR expires_at < now() - interval '24 hours' RETURNING id`);
  const tokens = await db.execute(sql`DELETE FROM email_verification_tokens
    WHERE token !~ ${HASH_ONLY} OR expires_at < now() - interval '24 hours'
       OR (used_at IS NOT NULL AND used_at < now() - interval '24 hours') RETURNING id`);
  return { codes: count(codes), tokens: count(tokens) };
}
