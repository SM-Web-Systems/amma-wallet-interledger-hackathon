// Test helper: a server fee quote with no Amma fee. Its innerHash stands in for the hash the server would submit.
import type { FeeQuote } from "../lib/api";

/** A deterministic 64-hex "hash" of a string (not cryptographic; tests only). */
export function fakeHash(s: string): string {
  let h = 2166136261;
  let out = "";
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ round, 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

export const noFeeQuote = async (xdr: string): Promise<FeeQuote> => ({ innerHash: fakeHash(xdr), fee: null, pays: [], networkFeePaidByAmma: true });
