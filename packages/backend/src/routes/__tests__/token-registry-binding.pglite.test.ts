import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Real SQL (PGlite) for the claim: the mocked tests cannot catch a wrong column or a dropped filter.
const h = vi.hoisted(() => ({ db: undefined as any }));
vi.mock("../../db", async () => {
  const schema = await import("../../db/schema");
  return { get db() { return h.db; }, schema };
});
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../db/schema";
import { markTokenUsed } from "../../services/token-registry.service";

let pg: PGlite;
const seed = (jti: string, clientId: string, tokenType: string, expiresInSec = 300) =>
  pg.query(
    `INSERT INTO token_registry (jti, token_type, sub, client_id, family_id, issued_at, expires_at)
     VALUES ($1, $2, '1', $3, 'fam-1', now(), now() + ($4 || ' seconds')::interval)`,
    [jti, tokenType, clientId, String(expiresInSec)],
  );
const row = async (jti: string) => (await pg.query<any>(`SELECT used_at, revoked_at FROM token_registry WHERE jti = $1`, [jti])).rows[0];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE token_registry (
    jti text PRIMARY KEY, token_type text NOT NULL, sub text NOT NULL, client_id text NOT NULL,
    family_id text, code_challenge text, redirect_uri text, scope text,
    issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
    used_at timestamptz, revoked_at timestamptz, created_at timestamptz DEFAULT now(),
    nonce text) -- oidc-nonce-v1`);
  h.db = drizzle(pg, { schema });
}, 60000);
beforeEach(async () => { await pg.exec("TRUNCATE token_registry"); });
afterAll(async () => { await pg?.close(); });

describe("markTokenUsed on a real database", () => {
  it("TR-B4: another client's claim leaves used_at NULL and the family unrevoked", async () => {
    await seed("code-1", "crm", "auth_code");
    expect(await markTokenUsed("code-1", "other", "auth_code")).toEqual({ alreadyUsed: true, familyId: null });
    expect(await row("code-1")).toEqual({ used_at: null, revoked_at: null });
    // The wrong token type from the right client is not burned either.
    expect(await markTokenUsed("code-1", "crm", "refresh")).toEqual({ alreadyUsed: true, familyId: null });
    expect(await row("code-1")).toEqual({ used_at: null, revoked_at: null });
    // The owner can still claim it, once.
    expect(await markTokenUsed("code-1", "crm", "auth_code")).toEqual({ alreadyUsed: false, familyId: "fam-1" });
    expect((await row("code-1")).used_at).not.toBeNull();
    // The owner's own replay reports the family to revoke.
    expect(await markTokenUsed("code-1", "crm", "auth_code")).toEqual({ alreadyUsed: true, familyId: "fam-1" });
  });

  it("TR-B5: an expired token is not claimed", async () => {
    await seed("old", "crm", "refresh", -10);
    expect((await markTokenUsed("old", "crm", "refresh")).alreadyUsed).toBe(true);
    expect((await row("old")).used_at).toBeNull();
  });
});
