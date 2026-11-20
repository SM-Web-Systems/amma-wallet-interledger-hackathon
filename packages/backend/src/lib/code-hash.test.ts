import { describe, it, expect, vi } from "vitest";

vi.mock("../config", () => ({
  config: { TOTP_ENCRYPTION_KEY: "a".repeat(64) },
}));

import { hashEmailCode, hashVerificationToken } from "./code-hash";

describe("code-hash (G-06)", () => {
  it("returns a 64 character hex digest that is not the input", () => {
    const h = hashEmailCode("123456");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("123456");
  });

  it("is stable for the same input and differs for different input", () => {
    expect(hashEmailCode("123456")).toBe(hashEmailCode("123456"));
    expect(hashEmailCode("123456")).not.toBe(hashEmailCode("123457"));
  });

  it("separates email codes from verification tokens", () => {
    expect(hashEmailCode("abc")).not.toBe(hashVerificationToken("abc"));
  });

  it("is keyed: a plain SHA-256 of six digits is not the stored value", async () => {
    const { createHash } = await import("node:crypto");
    const plain = createHash("sha256").update("123456").digest("hex");
    expect(hashEmailCode("123456")).not.toBe(plain);
  });

  it("changes with the server key", async () => {
    const first = hashEmailCode("123456");
    vi.resetModules();
    vi.doMock("../config", () => ({ config: { TOTP_ENCRYPTION_KEY: "b".repeat(64) } }));
    const other = await import("./code-hash");
    expect(other.hashEmailCode("123456")).not.toBe(first);
  });
});


import { hashStaticCode, checkStaticCode } from "./code-hash";
import { createHash } from "node:crypto";

describe("static 2FA code (G-06)", () => {
  const legacy = (code: string) => createHash("sha256").update(code).digest("hex");

  it("stores a keyed hash, not a plain SHA-256 of six digits", () => {
    const stored = hashStaticCode("123456", 1);
    expect(stored).toMatch(/^h1:[0-9a-f]{64}$/);
    expect(stored).not.toContain(legacy("123456"));
  });

  it("accepts the right code and rejects a wrong one", () => {
    const stored = hashStaticCode("123456", 1);
    expect(checkStaticCode(stored, "123456", 1)).toEqual({ valid: true, upgrade: null });
    expect(checkStaticCode(stored, "123457", 1)).toEqual({ valid: false, upgrade: null });
  });

  it("gives two people with the same code different stored values, and rejects another person's value", () => {
    expect(hashStaticCode("123456", 1)).not.toBe(hashStaticCode("123456", 2));
    expect(checkStaticCode(hashStaticCode("123456", 1), "123456", 2).valid).toBe(false);
  });

  it("still accepts a code stored the old way, and hands back the keyed hash to store instead", () => {
    const result = checkStaticCode(legacy("123456"), "123456", 7);
    expect(result.valid).toBe(true);
    expect(result.upgrade).toBe(hashStaticCode("123456", 7));
    expect(checkStaticCode(legacy("123456"), "000000", 7)).toEqual({ valid: false, upgrade: null });
  });

  it("rejects when nothing is stored", () => {
    expect(checkStaticCode(null, "123456", 1)).toEqual({ valid: false, upgrade: null });
  });
});
