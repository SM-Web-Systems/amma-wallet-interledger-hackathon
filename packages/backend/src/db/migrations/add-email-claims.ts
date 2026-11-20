import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// Additive only. Tokens with email NULL verify users.email as before; a non-NULL
// email is a pending claim that reaches users.email only after mailbox proof.
export async function addEmailClaims(db: PostgresJsDatabase) {
  await db.execute(sql`
    ALTER TABLE email_verification_tokens
    ADD COLUMN IF NOT EXISTS email TEXT;
  `);
}
