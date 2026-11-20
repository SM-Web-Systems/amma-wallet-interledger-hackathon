import { describe, it, expect, vi, beforeEach } from "vitest";
import { serverSource } from "../test-support/server-source";
import { readFileSync } from "fs";
import { join } from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { applyPlatformFee, feeForSubmit, feePaymentFailure, MAX_PRICED_ASSETS, platformFeeStep, resetPlatformFeeCaches } from "./platform-fee";
import { checkStellarTx } from "./custody-limits";

// Review fixes for PR #261 (second round).

const PASS = StellarSdk.Networks.PUBLIC;
const user = StellarSdk.Keypair.random().publicKey();
const platformKp = StellarSdk.Keypair.random();
const platform = platformKp.publicKey();
const dest = StellarSdk.Keypair.random().publicKey();
const issuer = StellarSdk.Keypair.random().publicKey();
const usdc = new StellarSdk.Asset("USDC", issuer);
const XLM = StellarSdk.Asset.native();
const tok = (code: string) => new StellarSdk.Asset(code, issuer);

const line = (a: StellarSdk.Asset) => ({ asset_type: "credit_alphanum4", asset_code: a.getCode(), asset_issuer: issuer, balance: "0", limit: "1000000", buying_liabilities: "0", is_authorized: true });
const horizon = (lines: any[] = [line(usdc)], quote = "0.0025000") => ({
  loadAccount: vi.fn(async () => ({ balances: lines })),
  strictReceivePaths: vi.fn(() => ({ call: async () => ({ records: [{ source_amount: quote }] }) })),
});
const warn = vi.fn();
const opts = (h: any = horizon(), extra: Record<string, any> = {}) => ({
  feePercent: 0.1, minFeeXlm: 0.01, platformWallet: platform, platformSecret: platformKp.secret(), source: user, passphrase: PASS, horizon: h, warn, ...extra,
});
const build = (ops: StellarSdk.xdr.Operation[], bounds?: { minTime: number; maxTime: number }) => {
  const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(user, "41"), { fee: "100", networkPassphrase: PASS });
  ops.forEach((o) => b.addOperation(o));
  if (bounds) b.setTimebounds(bounds.minTime, bounds.maxTime); else b.setTimeout(300);
  return StellarSdk.TransactionBuilder.fromXDR(b.build().toXDR(), PASS) as StellarSdk.Transaction;
};
const pay = (amount: string, asset = XLM) => StellarSdk.Operation.payment({ destination: dest, asset, amount });
const hex = (t: any) => t.hash().toString("hex");
const warned = (msg: string) => warn.mock.calls.filter((c) => c[1] === msg).map((c) => c[0]);

beforeEach(() => { resetPlatformFeeCaches(); warn.mockReset(); });

describe("deploy window: the fee is charged only when the client sent the quoted hash", () => {
  it("an old client (no expectedHash) gets NO fee and its own transaction, identical hash", async () => {
    const tx = build([pay("10")]);
    const r = await feeForSubmit(tx, undefined, opts());
    expect(r.refused).toBeUndefined();
    expect(r.finalTx).toBe(tx);
    expect(r.feeDetails).toBeNull();
    expect(r.innerHash).toBe(hex(tx));
    expect(warned("platform_fee_skipped")).toEqual([{ reason: "no_expected_hash" }]);
  });

  it("the fee quote still works for the same XDR, and a new client with the quoted hash is charged exactly that", async () => {
    const xdr = build([pay("10")]).toXDR();
    const quote = await platformFeeStep(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), opts());
    expect(quote.feeDetails).not.toBeNull();
    const r = await feeForSubmit(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), hex(quote.finalTx), opts());
    expect(r.refused).toBeUndefined();
    expect(r.innerHash).toBe(hex(quote.finalTx));
    expect((r.finalTx as StellarSdk.Transaction).operations).toHaveLength(2);
  });

  it("a different expected hash is refused with 409 fee_changed (nothing to sign)", async () => {
    const r = await feeForSubmit(build([pay("10")]), "0".repeat(64), opts());
    expect(r.refused).toEqual({ status: 409, code: "fee_changed", error: expect.stringMatching(/fee for this payment changed/) });
  });
});

describe("limits on the fee machinery", () => {
  it(`more than ${MAX_PRICED_ASSETS} issued assets: no price reads, percentage only, logged`, async () => {
    expect(MAX_PRICED_ASSETS).toBe(3);
    const codes = ["AAA", "BBB", "CCC", "DDD"];
    const h = horizon(codes.map((c) => line(tok(c))));
    const { finalTx } = await applyPlatformFee(build(codes.map((c) => pay("1", tok(c)))), opts(h));
    expect(h.strictReceivePaths).not.toHaveBeenCalled();
    expect(warned("platform_fee_too_many_assets")).toEqual([{ count: 4 }]);
    const fees = (finalTx as StellarSdk.Transaction).operations.slice(4) as any[];
    expect(fees.map((o) => [o.asset.getCode(), o.amount])).toEqual(codes.map((c) => [c, "0.0010000"]));
  });

  it("3 issued assets are still priced", async () => {
    const codes = ["AAA", "BBB", "CCC"];
    const h = horizon(codes.map((c) => line(tok(c))));
    await applyPlatformFee(build(codes.map((c) => pay("1", tok(c)))), opts(h));
    expect(h.strictReceivePaths).toHaveBeenCalledTimes(3);
  });

  it("thin order book: a minimum above 5% of the amount sent is not trusted (send 10 TOKEN, minimum quoted at 9 TOKEN)", async () => {
    const TOKEN = tok("TOKEN");
    const { finalTx } = await applyPlatformFee(build([pay("10", TOKEN)]), opts(horizon([line(TOKEN)], "9.0000000")));
    expect(((finalTx as StellarSdk.Transaction).operations[1] as any).amount).toBe("0.0100000");
    expect(warned("platform_fee_floor_unpriced")).toEqual([{ asset: "TOKEN", reason: "thin_book" }]);
  });

  it("a minimum of up to 5% is used (1 USDC, 0.0025 USDC minimum); exactly 5% too", async () => {
    let { finalTx } = await applyPlatformFee(build([pay("1", usdc)]), opts());
    expect(((finalTx as StellarSdk.Transaction).operations[1] as any).amount).toBe("0.0025000");
    resetPlatformFeeCaches();
    ({ finalTx } = await applyPlatformFee(build([pay("0.05", usdc)]), opts()));
    expect(((finalTx as StellarSdk.Transaction).operations[1] as any).amount).toBe("0.0025000");
  });

  it("no price at all logs reason no_price", async () => {
    await applyPlatformFee(build([pay("1", usdc)]), opts(horizon([line(usdc)], "not-a-number")));
    expect(warned("platform_fee_floor_unpriced")).toEqual([{ asset: "USDC", reason: "no_price" }]);
  });

  it("more than 100 operations with the fee payments: skipped, reason op_limit", async () => {
    const tx = build(Array.from({ length: 100 }, () => pay("1")));
    const r = await applyPlatformFee(tx, opts());
    expect(r.finalTx).toBe(tx);
    expect(warned("platform_fee_skipped")).toEqual([{ reason: "op_limit" }]);
  });

  it("maxTime above 2^53: not rebuilt, reason preconditions", async () => {
    // The SDK builder can't take such a number, so set it in the XDR directly.
    const env = build([pay("1")]).toEnvelope();
    env.v1().tx().cond(StellarSdk.xdr.Preconditions.precondTime(new StellarSdk.xdr.TimeBounds({
      minTime: StellarSdk.xdr.Uint64.fromString("0"), maxTime: StellarSdk.xdr.Uint64.fromString((2n ** 60n).toString()),
    })));
    const tx = StellarSdk.TransactionBuilder.fromXDR(env.toXDR("base64"), PASS) as StellarSdk.Transaction;
    expect(tx.timeBounds!.maxTime).toBe((2n ** 60n).toString());
    const r = await applyPlatformFee(tx, opts());
    expect(r.finalTx).toBe(tx);
    expect(warned("platform_fee_skipped")).toEqual([{ reason: "preconditions" }]);
  });
});

describe("the fee payment itself fails on the ledger (stale trustline answer)", () => {
  const rejected = (ops: string[]) => ({ response: { data: { extras: { result_codes: { transaction: "tx_fee_bump_inner_failed", inner_transaction: "tx_failed", operations: ops } } } } });

  it("names the fee asset, forgets the cached trustline, and the next envelope pays in XLM", async () => {
    const h = horizon();
    const first = (await applyPlatformFee(build([pay("100", usdc)]), opts(h))).finalTx as StellarSdk.Transaction;
    expect(h.loadAccount).toHaveBeenCalledTimes(1);
    // Ledger says: op 0 (the user's payment) fine, op 1 (the fee payment) op_no_trust.
    expect(feePaymentFailure(first, 1, rejected(["op_success", "op_no_trust"]))).toEqual({ asset: "USDC", code: "op_no_trust", kind: "trustline" });
    // The platform trustline is gone: a new envelope reads Horizon again and falls back to XLM.
    const h2 = horizon([]);
    const next = (await applyPlatformFee(build([pay("100.5", usdc)]), opts(h2))).finalTx as StellarSdk.Transaction;
    expect(h2.loadAccount).toHaveBeenCalledTimes(1);
    expect((next.operations[1] as any).asset.isNative()).toBe(true);
  });

  it("op_not_authorized, op_line_full and op_no_destination are trustline failures too", async () => {
    const tx = (await applyPlatformFee(build([pay("100", usdc)]), opts())).finalTx as StellarSdk.Transaction;
    for (const code of ["op_not_authorized", "op_line_full", "op_no_destination"]) {
      expect(feePaymentFailure(tx, 1, rejected(["op_success", code]))).toEqual({ asset: "USDC", code, kind: "trustline" });
    }
  });

  it("op_underfunded on the fee payment is the user's funds: no cache is dropped; op_low_reserve (not a payment code) is not a fee failure", async () => {
    const h = horizon();
    const tx = (await applyPlatformFee(build([pay("100", usdc)]), opts(h))).finalTx as StellarSdk.Transaction;
    expect(feePaymentFailure(tx, 1, rejected(["op_success", "op_underfunded"]))).toEqual({ asset: "USDC", code: "op_underfunded", kind: "funds" });
    expect(feePaymentFailure(tx, 1, rejected(["op_success", "op_low_reserve"]))).toBeNull();
    // The trustline answer is still cached: a new envelope makes no platform account read and still pays in USDC.
    const h2 = horizon([]);
    const next = (await applyPlatformFee(build([pay("100.5", usdc)]), opts(h2))).finalTx as StellarSdk.Transaction;
    expect(h2.loadAccount).not.toHaveBeenCalled();
    expect((next.operations[1] as any).asset.getCode()).toBe("USDC");
  });

  it("a failure of the user's own operation is not a fee failure", () => {
    const tx = build([pay("1"), pay("2", usdc)]);
    expect(feePaymentFailure(tx, 2, rejected(["op_underfunded", "op_success"]))).toBeNull();
    expect(feePaymentFailure(tx, 2, { message: "no codes" })).toBeNull();
  });
});

describe("custody cap message says the limit includes the fee", () => {
  it("XLM and token per-payment refusals", () => {
    const tx = build([pay("10.0000001")]);
    expect(checkStellarTx(10n * 10_000_000n, tx.operations as any, { wallet: user, tokens: new Map() })?.error).toMatch(/limit for one payment\. This limit includes the Amma fee\./);
  });
});

describe("sign-and-submit wiring (source)", () => {
  const src = serverSource();
  const block = src.slice(src.indexOf('"/api/v1/transactions/sign-and-submit"'), src.indexOf('"/api/v1/user/signing-mode"'));
  it("uses feeForSubmit, and checks the PIN (presence and unlock) before the fee step reads Horizon", () => {
    expect(block).toContain("feeForSubmit(tx, expectedHash, {");
    const fee = block.indexOf("feeForSubmit(tx, expectedHash, {");
    expect(block.indexOf('error: "pin is required for delegated signing"')).toBeLessThan(fee);
    expect(block.indexOf("decryptSecret(")).toBeLessThan(fee);
  });
  it("a failed fee payment gets its own message and keeps the op_ code (the web builds a new envelope)", () => {
    expect(block).toContain("feePaymentFailure(finalTx, ");
    expect(block).toContain('"platform_fee_payment_failed"');
  });
});
