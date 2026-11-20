import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ update: vi.fn(), select: vi.fn(), where: vi.fn() }));
// Record the WHERE parts as plain objects so the test can read them.
vi.mock("drizzle-orm", async (orig) => {
  const real = await orig<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
    and: (...parts: unknown[]) => ({ and: parts }),
    isNull: (column: unknown) => ({ isNull: column }),
    gt: (column: unknown, value: unknown) => ({ gt: [column, value] }),
  };
});
vi.mock("../../db", () => ({
  db: { update: (...a: any[]) => h.update(...a), select: (...a: any[]) => h.select(...a) },
  schema: { tokenRegistry: { jti: "jti", tokenType: "token_type", clientId: "client_id", familyId: "family_id", usedAt: "used_at", revokedAt: "revoked_at", expiresAt: "expires_at" } },
}));
import { markTokenUsed } from "../../services/token-registry.service";

const claimReturns = (rows: unknown[]) =>
  h.update.mockReturnValue({ set: () => ({ where: (cond: unknown) => { h.where(cond); return { returning: () => rows }; } }) });
const lookupReturns = (rows: unknown[]) => h.select.mockReturnValue({ from: () => ({ where: () => rows }) });
beforeEach(() => { h.update.mockReset(); h.select.mockReset(); h.where.mockReset(); });

describe("markTokenUsed binds the claim to the caller", () => {
  it("TR-B1: the atomic UPDATE filters on jti, client_id and token_type", async () => {
    claimReturns([{ familyId: "fam-1" }]);
    expect(await markTokenUsed("abc", "crm", "auth_code")).toEqual({ alreadyUsed: false, familyId: "fam-1" });
    const parts = (h.where.mock.calls[0][0] as { and: unknown[] }).and;
    expect(parts).toHaveLength(6);
    expect(parts).toEqual(expect.arrayContaining([{ eq: ["jti", "abc"] }, { eq: ["client_id", "crm"] }, { eq: ["token_type", "auth_code"] }]));
  });

  it("TR-B2: a miss on another client's token reports no family to revoke", async () => {
    claimReturns([]);
    lookupReturns([{ jti: "abc", clientId: "crm", tokenType: "auth_code", familyId: "fam-1" }]);
    expect(await markTokenUsed("abc", "other", "auth_code")).toEqual({ alreadyUsed: true, familyId: null });
    lookupReturns([{ jti: "abc", clientId: "crm", tokenType: "refresh", familyId: "fam-1" }]);
    expect(await markTokenUsed("abc", "crm", "auth_code")).toEqual({ alreadyUsed: true, familyId: null });
  });

  it("TR-B3: a miss on the caller's own used token still reports its family", async () => {
    claimReturns([]);
    lookupReturns([{ jti: "abc", clientId: "crm", tokenType: "refresh", familyId: "fam-1" }]);
    expect(await markTokenUsed("abc", "crm", "refresh")).toEqual({ alreadyUsed: true, familyId: "fam-1" });
  });
});
