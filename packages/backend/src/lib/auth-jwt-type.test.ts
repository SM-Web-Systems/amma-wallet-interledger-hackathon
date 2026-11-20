import { describe, it, expect, vi } from "vitest";

vi.mock("../config", () => ({
  config: {
    JWT_SECRET: "test-jwt-secret-for-type-test",
    JWT_REFRESH_SECRET: "test-refresh-secret",
    JWT_EXPIRES_IN: 900,
    JWT_REFRESH_EXPIRES_IN: 604800,
  },
}));

vi.mock("../db", () => ({
  db: { insert: vi.fn().mockReturnThis(), values: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../db/schema", () => ({
  refreshTokens: {},
}));

import { generateAccessToken, verifyAccessToken, generateRefreshToken, verifyRefreshToken, hashToken } from "./auth";

describe("JWT type claim (P0-1-F9)", () => {
  it("generateAccessToken includes type:'user' in payload", () => {
    const token = generateAccessToken({ userId: 1, email: "test@example.com" });
    const decoded = verifyAccessToken(token);
    expect(decoded.type).toBe("user");
  });

  it("verifyAccessToken returns userId and email", () => {
    const token = generateAccessToken({ userId: 42, email: "a@b.com" });
    const decoded = verifyAccessToken(token);
    expect(decoded.userId).toBe(42);
    expect(decoded.email).toBe("a@b.com");
  });
});

import jwt from "jsonwebtoken";
import { authMiddleware } from "../middleware/auth";

const SECRET = "test-jwt-secret-for-type-test";

async function runMiddleware(token: string) {
  const reply = { statusCode: 0, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    send(body: unknown) { this.body = body; return this; } };
  const request = { headers: { authorization: `Bearer ${token}` } } as any;
  await authMiddleware(request, reply as any);
  return { request, reply };
}

describe("user access tokens are allowlisted by type", () => {
  const sign = (claims: Record<string, unknown>) => jwt.sign(claims, SECRET, { expiresIn: 60 });

  it.each([
    ["admin", { userId: 1, email: null, type: "admin" }],
    ["service", { userId: 1, email: null, type: "service" }],
    ["oauth-access", { userId: 1, email: null, type: "oauth-access" }],
    ["impersonation", { userId: 1, email: null, type: "impersonation" }],
    ["missing type (refresh-shaped)", { userId: 1, email: null }],
    ["non-integer userId", { userId: "1", email: null, type: "user" }],
    ["zero userId", { userId: 0, email: null, type: "user" }],
  ])("verifyAccessToken rejects a %s token signed with the user secret", (_label, claims) => {
    expect(() => verifyAccessToken(sign(claims))).toThrow();
  });

  it("verifyAccessToken rejects alg:none and other algorithms", () => {
    const none = jwt.sign({ userId: 1, email: null, type: "user" }, "", { algorithm: "none" } as any);
    expect(() => verifyAccessToken(none)).toThrow();
    const hs512 = jwt.sign({ userId: 1, email: null, type: "user" }, SECRET, { algorithm: "HS512" });
    expect(() => verifyAccessToken(hs512)).toThrow();
  });

  it("authMiddleware accepts a user token and sets request.user", async () => {
    const { request, reply } = await runMiddleware(generateAccessToken({ userId: 7, email: "u@example.test" }));
    expect(reply.statusCode).toBe(0);
    expect(request.user).toMatchObject({ userId: 7, type: "user" });
  });

  it.each(["admin", "service", "oauth-access", undefined])("authMiddleware rejects type %s with 401", async type => {
    const { request, reply } = await runMiddleware(sign({ userId: 7, email: null, ...(type ? { type } : {}) }));
    expect(reply.statusCode).toBe(401);
    expect(request.user).toBeUndefined();
  });

  it("authMiddleware rejects a refresh token", async () => {
    const { reply } = await runMiddleware(generateRefreshToken({ userId: 7, email: null }));
    expect(reply.statusCode).toBe(401);
  });
});

describe('refresh tokens issued within one second',()=>{
 it('keeps independent logins and immediate refreshes distinct for the unique token-hash store',()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
  try {
   const first=generateRefreshToken({userId:42,email:'local@example.test'});
   const second=generateRefreshToken({userId:42,email:'local@example.test'});
   expect(second).not.toBe(first);
   expect(hashToken(second)).not.toBe(hashToken(first));
   expect(verifyRefreshToken(first).userId).toBe(42);
   expect(verifyRefreshToken(second).email).toBe('local@example.test');
  } finally {vi.useRealTimers();}
 });
});
