import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";

/**
 * PBKDF2-HMAC-SHA256 with a 32-byte output, for the wallet vault.
 *
 * On an installed build it runs in native code (react-native-quick-crypto), which takes well under a
 * second. In Expo Go, in tests, or if anything about the native module looks wrong it runs in pure
 * JavaScript (@noble), which gives the same bytes but takes minutes on an entry-level phone. The
 * number of rounds is never changed, so a vault written either way opens either way.
 */
export type NativePbkdf2 = (password: Uint8Array, salt: Uint8Array, iterations: number) => Promise<Uint8Array>;

const js: NativePbkdf2 = (password, salt, iterations) => pbkdf2Async(sha256, password, salt, { c: iterations, dkLen: 32 });

function loadQuickCrypto(): NativePbkdf2 | null {
  // Loaded lazily and inside a try/catch by the caller: this throws where the native module is absent.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const quick = require("react-native-quick-crypto") as {
    pbkdf2: (p: Uint8Array, s: Uint8Array, c: number, len: number, digest: string, cb: (err: Error | null, key?: ArrayLike<number>) => void) => void;
  };
  if (typeof quick.pbkdf2 !== "function") return null;
  return (password, salt, iterations) =>
    new Promise<Uint8Array>((resolve, reject) => {
      quick.pbkdf2(password, salt, iterations, 32, "sha256", (err, key) => (err || !key ? reject(err ?? new Error("No key")) : resolve(new Uint8Array(key))));
    });
}

let loader: () => NativePbkdf2 | null = loadQuickCrypto;
let resolved: Promise<NativePbkdf2 | null> | null = null;

/** Test hook: replaces how the native implementation is found, and forgets any earlier answer. */
export function setNativePbkdf2Loader(next: () => NativePbkdf2 | null): void {
  loader = next;
  resolved = null;
}

const SELF_CHECK = { password: new TextEncoder().encode("amma-pbkdf2-self-check"), salt: Uint8Array.from({ length: 16 }, (_, i) => i + 1), iterations: 1000 };

/** The native implementation, but only once it has produced the same bytes as the JavaScript one. */
function nativeImplementation(): Promise<NativePbkdf2 | null> {
  resolved ??= (async () => {
    try {
      const native = loader();
      if (!native) return null;
      const { password, salt, iterations } = SELF_CHECK;
      const [fast, slow] = await Promise.all([native(password, salt, iterations), js(password, salt, iterations)]);
      return fast.length === slow.length && fast.every((b, i) => b === slow[i]) ? native : null;
    } catch {
      return null;
    }
  })();
  return resolved;
}

export async function pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const native = await nativeImplementation();
  if (native) {
    try {
      return await native(password, salt, iterations);
    } catch {
      // fall through to the JavaScript implementation
    }
  }
  return js(password, salt, iterations);
}
