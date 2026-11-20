// Picks which recovery-phrase words the user must re-enter during onboarding.
// Uses crypto.getRandomValues (polyfilled by react-native-get-random-values),
// never Math.random, so the challenge positions are not predictable.

const RANGE = 0x1_0000_0000; // 2^32

/** Uniform integer in [0, max) from crypto.getRandomValues, via rejection sampling. */
export function secureRandomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > RANGE) {
    throw new RangeError(`secureRandomInt: max must be an integer in 1..2^32, got ${max}`);
  }
  const limit = RANGE - (RANGE % max); // values >= limit would bias the result
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/** `count` distinct word positions in [0, wordCount), sorted ascending. */
export function pickVerifyIndices(wordCount: number, count = 3): number[] {
  if (!Number.isInteger(count) || count < 1 || count > wordCount) {
    throw new RangeError(`pickVerifyIndices: cannot pick ${count} of ${wordCount}`);
  }
  const picked = new Set<number>();
  while (picked.size < count) picked.add(secureRandomInt(wordCount));
  return [...picked].sort((a, b) => a - b);
}
