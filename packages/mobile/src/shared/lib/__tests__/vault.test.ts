import { describe, expect, it } from "vitest";
import {
  createVaultKey,
  openSecret,
  sealSecret,
  unwrapVaultKey,
  wrapVaultKey,
  isSealed,
  VAULT_ITERATIONS,
} from "../vault";
import { passphraseProblem } from "../passphrase";

const FAST = { iterations: 1000 }; // the real cost is checked separately below
const SECRET = "SAV76USXIJOBMEQXPANUOQM6F5LIOTLPDIDVRJBFFE2MDJXG24TAPUU7"; // public SEP-0005 test vector

describe("passphrase rule (same as web and extension)", () => {
  it("rejects short or digits-only passphrases", () => {
    expect(passphraseProblem("123456")).toMatch(/12/);
    expect(passphraseProblem("123456789012")).toMatch(/numbers/);
    expect(passphraseProblem("correct horse battery")).toBeNull();
  });
});

describe("vault", () => {
  it("wraps the vault key with the passphrase and opens it only with that passphrase", async () => {
    const key = createVaultKey();
    const wrapped = await wrapVaultKey(key, "correct horse battery", FAST);
    expect(Array.from(await unwrapVaultKey(wrapped, "correct horse battery"))).toEqual(Array.from(key));
    await expect(unwrapVaultKey(wrapped, "correct horse batterY")).rejects.toThrow(/passphrase/i);
  });

  it("uses a slow KDF by default and records its parameters", async () => {
    expect(VAULT_ITERATIONS).toBeGreaterThanOrEqual(100_000);
    const wrapped = JSON.parse(await wrapVaultKey(createVaultKey(), "correct horse battery", FAST));
    expect(wrapped).toMatchObject({ v: 1, kdf: "pbkdf2-sha256", iterations: 1000 });
    expect(wrapped.salt).toMatch(/^[A-Za-z0-9+/=]{20,}$/);
  });

  it("seals secrets so the stored value never contains the secret", () => {
    const key = createVaultKey();
    const sealed = sealSecret(key, SECRET);
    expect(isSealed(sealed)).toBe(true);
    expect(isSealed(SECRET)).toBe(false);
    expect(sealed).not.toContain(SECRET);
    expect(sealed).not.toContain(SECRET.slice(1, 20));
    expect(openSecret(key, sealed)).toBe(SECRET);
    // fresh IV each time
    expect(sealSecret(key, SECRET)).not.toBe(sealed);
  });

  it("fails on tampering or the wrong key", () => {
    const key = createVaultKey();
    const sealed = sealSecret(key, SECRET);
    const body = sealed.slice(3);
    const flipped = "v1:" + (body[5] === "A" ? body.slice(0, 5) + "B" + body.slice(6) : body.slice(0, 5) + "A" + body.slice(6));
    expect(() => openSecret(key, flipped)).toThrow();
    expect(() => openSecret(createVaultKey(), sealed)).toThrow();
  });
});
