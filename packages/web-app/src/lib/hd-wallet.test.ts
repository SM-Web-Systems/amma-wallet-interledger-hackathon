import { describe, it, expect } from "vitest";
import { deriveHDKeypair, isValidMnemonic } from "./hd-wallet";

// BIP39 test vector: 12-word "abandon" mnemonic
// SEP-0005 derivation path: m/44'/148'/accountIndex'
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("hd-wallet: client-side HD derivation (P0-3-F2)", () => {
  describe("deriveHDKeypair", () => {
    it("derives correct public key for index 0 (SEP-0005 test vector)", () => {
      const { publicKey } = deriveHDKeypair(TEST_MNEMONIC, 0);
      expect(publicKey).toBe(
        "GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX"
      );
    });

    it("derives correct public key for index 1", () => {
      const { publicKey } = deriveHDKeypair(TEST_MNEMONIC, 1);
      expect(publicKey).toBe(
        "GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV"
      );
    });

    it("returns a secret key starting with S", () => {
      const { secretKey } = deriveHDKeypair(TEST_MNEMONIC, 0);
      expect(secretKey).toMatch(/^S[A-Z2-7]{55}$/);
    });

    it("throws on invalid mnemonic", () => {
      expect(() => deriveHDKeypair("not a valid mnemonic phrase", 0)).toThrow(
        /invalid mnemonic/i
      );
    });

    it("throws on empty string", () => {
      expect(() => deriveHDKeypair("", 0)).toThrow(/invalid mnemonic/i);
    });
  });

  describe("isValidMnemonic", () => {
    it("returns true for valid 12-word mnemonic", () => {
      expect(isValidMnemonic(TEST_MNEMONIC)).toBe(true);
    });

    it("returns false for garbage input", () => {
      expect(isValidMnemonic("hello world foo bar")).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isValidMnemonic("")).toBe(false);
    });
  });
});

// ── 12/24-word recovery phrases (seed-phrase fix, 2026-11-10) ──────────────
import { generateRecoveryPhrase, normalizeMnemonic, RECOVERY_WORD_COUNTS } from "./hd-wallet";

// SEP-0005 published test vectors (m/44'/148'/0')
const SEP5_12 = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const SEP5_24 =
  "bench hurt jump file august wise shallow faculty impulse spring exact slush thunder author capable act festival slice deposit sauce coconut afford frown better";

describe("recovery phrases: 12 and 24 words", () => {
  it("offers exactly 12 and 24 words", () => {
    expect(RECOVERY_WORD_COUNTS).toEqual([12, 24]);
  });

  it.each([12, 24] as const)("generates a valid %i-word phrase", (count) => {
    const phrase = generateRecoveryPhrase(count);
    expect(phrase.split(" ")).toHaveLength(count);
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it("defaults to 24 words, as SEP-0005 recommends", () => {
    expect(generateRecoveryPhrase().split(" ")).toHaveLength(24);
  });

  it("rejects any other word count", () => {
    expect(() => generateRecoveryPhrase(18 as never)).toThrow(/12 or 24/);
  });

  it("never repeats a phrase", () => {
    expect(generateRecoveryPhrase(12)).not.toBe(generateRecoveryPhrase(12));
  });

  it("derives the SEP-0005 12-word vector", () => {
    expect(deriveHDKeypair(SEP5_12, 0).publicKey).toBe("GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6");
  });

  it("derives the SEP-0005 24-word vector", () => {
    expect(deriveHDKeypair(SEP5_24, 0).publicKey).toBe("GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ");
  });

  it("accepts phrases typed with capitals, extra spaces or new lines", () => {
    const messy = `  ${SEP5_24.toUpperCase().split(" ").join("   ").replace(/ACT /, "act\n")}  `;
    expect(isValidMnemonic(messy)).toBe(true);
    expect(normalizeMnemonic(messy)).toBe(SEP5_24);
    expect(deriveHDKeypair(messy, 0).publicKey).toBe(deriveHDKeypair(SEP5_24, 0).publicKey);
  });
});
