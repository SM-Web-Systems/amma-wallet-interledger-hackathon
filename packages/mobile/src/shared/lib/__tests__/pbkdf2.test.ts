import { beforeEach, describe, expect, it, vi } from "vitest";
import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";
import { pbkdf2Sha256, setNativePbkdf2Loader, type NativePbkdf2 } from "../pbkdf2";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const reference = (password: Uint8Array, salt: Uint8Array, c: number) => pbkdf2Async(sha256, password, salt, { c, dkLen: 32 });

// A correct native implementation, standing in for react-native-quick-crypto.
const goodNative = (): NativePbkdf2 => vi.fn(async (p, s, c) => reference(p, s, c));

beforeEach(() => setNativePbkdf2Loader(() => null));

describe("PBKDF2-SHA256", () => {
  it("matches the published vector (c=4096), so existing vaults keep opening", async () => {
    const out = await pbkdf2Sha256(enc.encode("password"), enc.encode("salt"), 4096);
    expect(hex(out)).toBe("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
  });

  it("uses the native implementation when it is present and passes its self-check", async () => {
    const native = goodNative();
    setNativePbkdf2Loader(() => native);
    const salt = enc.encode("0123456789abcdef");
    const out = await pbkdf2Sha256(enc.encode("a long enough passphrase"), salt, 5000);
    expect(hex(out)).toBe(hex(await reference(enc.encode("a long enough passphrase"), salt, 5000)));
    // once for the self-check, once for the real call
    expect(native).toHaveBeenCalledTimes(2);
    expect(vi.mocked(native).mock.calls[1][2]).toBe(5000);
  });

  it("falls back to the JavaScript implementation when the native one gives a wrong answer", async () => {
    const wrong: NativePbkdf2 = vi.fn(async () => new Uint8Array(32));
    setNativePbkdf2Loader(() => wrong);
    const out = await pbkdf2Sha256(enc.encode("password"), enc.encode("salt"), 4096);
    expect(hex(out)).toBe("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
    expect(wrong).toHaveBeenCalledTimes(1); // only the self-check, never the real derivation
  });

  it("falls back when the native implementation throws, at self-check or later", async () => {
    setNativePbkdf2Loader(() => vi.fn(async () => { throw new Error("native module missing"); }));
    expect(hex(await pbkdf2Sha256(enc.encode("password"), enc.encode("salt"), 4096))).toBe("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");

    let calls = 0;
    setNativePbkdf2Loader(() => async (p, s, c) => {
      if (++calls > 1) throw new Error("native failed mid-way");
      return reference(p, s, c);
    });
    expect(hex(await pbkdf2Sha256(enc.encode("password"), enc.encode("salt"), 4096))).toBe("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
  });

  it("falls back when loading the native module throws (Expo Go, tests)", async () => {
    setNativePbkdf2Loader(() => { throw new Error("Cannot find native module"); });
    expect(hex(await pbkdf2Sha256(enc.encode("password"), enc.encode("salt"), 4096))).toBe("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a");
  });
});
