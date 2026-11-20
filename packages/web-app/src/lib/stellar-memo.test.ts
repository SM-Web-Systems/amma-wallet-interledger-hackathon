// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { StellarSdk, buildPaymentTx, validateMemo, makeMemo, memoLooksLikeHash } from "./stellar";

async function run(memo?: string, memoType?: "text" | "id" | "hash") {
  const kp = StellarSdk.Keypair.random();
  const dest = StellarSdk.Keypair.random().publicKey();
  vi.spyOn(StellarSdk.Horizon.Server.prototype, "loadAccount").mockResolvedValue(
    Object.assign(new StellarSdk.Account(kp.publicKey(), "1"), { balances: [{ asset_type: "native", balance: "1000" }], subentry_count: 0 }) as unknown as Awaited<ReturnType<typeof StellarSdk.Horizon.Server.prototype.loadAccount>>
  );
  let submitted: StellarSdk.Transaction | undefined;
  vi.spyOn(StellarSdk.Horizon.Server.prototype, "submitTransaction").mockImplementation(async (tx) => { submitted = tx as StellarSdk.Transaction; return {} as StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse; });
  await buildPaymentTx(kp.secret(), dest, "5", "XLM", undefined, memo, memoType);
  // Round-trip through XDR so we assert what actually goes on the wire.
  return StellarSdk.TransactionBuilder.fromXDR(submitted!.toXDR(), submitted!.networkPassphrase) as StellarSdk.Transaction;
}
afterEach(() => vi.restoreAllMocks());

describe("buildPaymentTx memo", () => {
  it("adds a text memo equal to the input", async () => {
    const tx = await run("hello");
    expect(tx.memo.type).toBe("text");
    expect(tx.memo.value.toString()).toBe("hello");
  });
  it("adds an id memo", async () => {
    const tx = await run("18446744073709551615", "id");
    expect(tx.memo.type).toBe("id");
    expect(tx.memo.value).toBe("18446744073709551615");
  });
  it("adds a hash memo", async () => {
    const tx = await run("ab".repeat(32), "hash");
    expect(tx.memo.type).toBe("hash");
    expect(Buffer.from(tx.memo.value).toString("hex")).toBe("ab".repeat(32));
  });
  it("builds a transaction whose memo is Memo.hash with the right bytes, from upper case input", async () => {
    const tx = await run("AB12".repeat(16), "hash");
    expect(tx.memo.type).toBe("hash");
    expect(Buffer.from(tx.memo.value).toString("hex")).toBe("ab12".repeat(16));
  });
  it("has MemoNone without a memo or with a blank one", async () => {
    expect((await run()).memo.type).toBe("none");
    expect((await run("   ")).memo.type).toBe("none");
  });
});

describe("validateMemo", () => {
  it("checks text length in bytes", () => {
    expect(validateMemo("text", "a".repeat(28))).toBeNull();
    expect(validateMemo("text", "a".repeat(29))).toBe("send.memoTooLong");
    expect(validateMemo("text", "é".repeat(15))).toBe("send.memoTooLong");
  });
  it("checks id and hash", () => {
    expect(validateMemo("id", "0")).toBeNull();
    expect(validateMemo("id", "-1")).toBe("send.memoIdInvalid");
    expect(validateMemo("id", "18446744073709551616")).toBe("send.memoIdInvalid");
    expect(validateMemo("hash", "ab".repeat(32))).toBeNull();
    expect(validateMemo("hash", "zz".repeat(32))).toBe("send.memoHashInvalid");
  });
});

describe("hash memo validation", () => {
  const h64 = "0123456789abcdef".repeat(4);
  it("accepts exactly 64 hex characters, either case", () => {
    expect(validateMemo("hash", h64)).toBeNull();
    expect(validateMemo("hash", h64.toUpperCase())).toBeNull();
    expect(validateMemo("hash", "aB".repeat(32))).toBeNull();
  });
  it("rejects 63 and 65 characters", () => {
    expect(validateMemo("hash", h64.slice(1))).toBe("send.memoHashInvalid");
    expect(validateMemo("hash", h64 + "a")).toBe("send.memoHashInvalid");
    expect(validateMemo("hash", "")).toBe("send.memoHashInvalid");
  });
  it("rejects non-hex characters", () => {
    expect(validateMemo("hash", h64.slice(1) + "g")).toBe("send.memoHashInvalid");
    expect(validateMemo("hash", h64.slice(1) + " ")).toBe("send.memoHashInvalid");
  });
  it("rejects a 0x prefix with its own message, even when the rest is 64 hex", () => {
    expect(validateMemo("hash", "0x" + h64)).toBe("send.memoHashPrefix");
    expect(validateMemo("hash", "0X" + h64)).toBe("send.memoHashPrefix");
    expect(validateMemo("hash", "0x" + h64.slice(2))).toBe("send.memoHashPrefix");
  });
  it("makeMemo refuses a 0x-prefixed hash", () => {
    expect(() => makeMemo("hash", "0x" + h64)).toThrow("send.memoHashPrefix");
  });
  it("makeMemo produces Memo.hash carrying the exact bytes, for upper case too", () => {
    for (const v of [h64, h64.toUpperCase()]) {
      const m = makeMemo("hash", v);
      expect(m.type).toBe("hash");
      expect(Buffer.from(m.value as Buffer).toString("hex")).toBe(h64);
    }
  });
});

describe("memoLooksLikeHash", () => {
  const h64 = "0123456789abcdef".repeat(4);
  it("is true only for 64 hex characters", () => {
    expect(memoLooksLikeHash(h64)).toBe(true);
    expect(memoLooksLikeHash(h64.toUpperCase())).toBe(true);
    expect(memoLooksLikeHash(h64.slice(1))).toBe(false);
    expect(memoLooksLikeHash(h64 + "a")).toBe(false);
    expect(memoLooksLikeHash("hello")).toBe(false);
  });
});
