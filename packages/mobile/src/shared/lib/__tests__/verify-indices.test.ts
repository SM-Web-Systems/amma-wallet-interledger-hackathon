import { afterEach, describe, expect, it, vi } from "vitest";
import { pickVerifyIndices, secureRandomInt } from "../verify-indices";

afterEach(() => vi.restoreAllMocks());

describe("pickVerifyIndices", () => {
  it.each([12, 24])("returns 3 distinct sorted indices within a %i-word phrase", (n) => {
    for (let run = 0; run < 200; run++) {
      const idx = pickVerifyIndices(n, 3);
      expect(idx).toHaveLength(3);
      expect(new Set(idx).size).toBe(3);
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      for (const i of idx) {
        expect(Number.isInteger(i)).toBe(true);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(n);
      }
    }
  });

  it("draws from crypto.getRandomValues and never from Math.random", () => {
    const mathSpy = vi.spyOn(Math, "random");
    const cryptoSpy = vi.spyOn(globalThis.crypto, "getRandomValues");
    pickVerifyIndices(24, 3);
    expect(mathSpy).not.toHaveBeenCalled();
    expect(cryptoSpy).toHaveBeenCalled();
  });

  it("rejects impossible requests", () => {
    expect(() => pickVerifyIndices(2, 3)).toThrow();
  });
});

describe("secureRandomInt", () => {
  it("rejects values in the biased tail (rejection sampling)", () => {
    // 2^32 % 24 = 16, so 0xffffffff falls in the biased tail and must be redrawn.
    const values = [0xffffffff, 25];
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((arr: ArrayBufferView) => {
      (arr as unknown as Uint32Array)[0] = values.shift()!;
      return arr;
    });
    expect(secureRandomInt(24)).toBe(1);
  });

  it("covers every value of a 12-word range", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(secureRandomInt(12));
    expect(seen.size).toBe(12);
  });
});
