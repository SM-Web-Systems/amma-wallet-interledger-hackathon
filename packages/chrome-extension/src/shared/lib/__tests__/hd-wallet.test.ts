import { describe, expect, it } from "vitest";
import {
  deriveHDKeypair,
  generateRecoveryPhrase,
  isValidMnemonic,
  normalizeMnemonic,
  RECOVERY_WORD_COUNTS,
} from "../hd-wallet";

// SEP-0005 published test vectors (m/44'/148'/0')
const SEP5_12 = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const SEP5_24 =
  "bench hurt jump file august wise shallow faculty impulse spring exact slush thunder author capable act festival slice deposit sauce coconut afford frown better";

describe("extension recovery phrases", () => {
  it("offers exactly 12 and 24 words", () => {
    expect(RECOVERY_WORD_COUNTS).toEqual([12, 24]);
  });

  it("defaults to 24 words", () => {
    const phrase = generateRecoveryPhrase();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it.each([12, 24] as const)("generates a valid %i-word phrase", (n) => {
    const phrase = generateRecoveryPhrase(n);
    expect(phrase.split(" ")).toHaveLength(n);
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it("rejects other word counts", () => {
    expect(() => generateRecoveryPhrase(18 as never)).toThrow(/12 or 24/);
  });

  it("derives the SEP-0005 12- and 24-word vectors", () => {
    expect(deriveHDKeypair(SEP5_12, 0).publicKey).toBe("GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6");
    expect(deriveHDKeypair(SEP5_24, 0).publicKey).toBe("GC3MMSXBWHL6CPOAVERSJITX7BH76YU252WGLUOM5CJX3E7UCYZBTPJQ");
  });

  it("normalizes capitals, extra spaces, tabs and new lines", () => {
    const messy = `  ${SEP5_24.toUpperCase().split(" ").join("  \t").replace(/ACT/, "act\n")}\n`;
    expect(normalizeMnemonic(messy)).toBe(SEP5_24);
    expect(isValidMnemonic(messy)).toBe(true);
    expect(deriveHDKeypair(messy, 0).publicKey).toBe(deriveHDKeypair(SEP5_24, 0).publicKey);
  });

  it("rejects an invalid checksum", () => {
    expect(isValidMnemonic(SEP5_12.replace(/toe$/, "abandon"))).toBe(false);
    expect(() => deriveHDKeypair("not a phrase", 0)).toThrow(/invalid mnemonic/i);
  });
});
