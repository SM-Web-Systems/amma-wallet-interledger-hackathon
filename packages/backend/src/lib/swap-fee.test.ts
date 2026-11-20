import { describe, it, expect, vi } from "vitest";
import { serverSource } from "../test-support/server-source";
import { readFileSync } from "fs";
import { join } from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { planCharges, perOpFee } from "./fee-rebuild";
import { applyPlatformFee, resetPlatformFeeCaches } from "./platform-fee";

const user = StellarSdk.Keypair.random().publicKey();
const dest = StellarSdk.Keypair.random().publicKey();
const platform = StellarSdk.Keypair.random().publicKey();
const issuer = StellarSdk.Keypair.random().publicKey();
const usdc = new StellarSdk.Asset("USDC", issuer);
const eurc = new StellarSdk.Asset("EURC", issuer);
const XLM = StellarSdk.Asset.native();

// Platform account as Horizon returns it: native balance plus the given trustlines.
const line = (a: StellarSdk.Asset, o: Partial<Record<string, any>> = {}) => ({
  asset_type: a.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
  asset_code: a.code, asset_issuer: a.issuer, balance: "0.0000000", limit: "922337203685.4775807",
  buying_liabilities: "0.0000000", selling_liabilities: "0.0000000", is_authorized: true, ...o,
});
const horizonWith = (...lines: any[]) => ({
  loadAccount: vi.fn(async (_id: string) => ({ balances: [{ asset_type: "native", balance: "50.0000000" }, ...lines] })),
  // 0.01 XLM costs 0.0025 of any asset (floor price)
  strictReceivePaths: vi.fn(() => ({ call: async () => ({ records: [{ source_amount: "0.0025000" }] }) })),
});
const noHorizon = () => ({ loadAccount: vi.fn(async () => { throw new Error("must not be called"); }) });

function build(ops: StellarSdk.xdr.Operation[], fee = "100", memo?: StellarSdk.Memo) {
  const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(user, "41"), { fee, networkPassphrase: StellarSdk.Networks.PUBLIC });
  ops.forEach((o) => b.addOperation(o));
  if (memo) b.addMemo(memo);
  return b.setTimeout(30).build();
}

// The sign-and-submit fee step itself (lib/platform-fee.ts). Caches are cleared per call: these tests are about one decision each.
async function charge(orig: StellarSdk.Transaction, pct: number, horizon: any = noHorizon()) {
  resetPlatformFeeCaches();
  const warn = vi.fn();
  const r = await applyPlatformFee(orig, { feePercent: pct, minFeeXlm: 0.01, platformWallet: platform, platformSecret: "S-not-used-here", source: user, passphrase: StellarSdk.Networks.PUBLIC, horizon, warn });
  // Assets whose fee went to XLM because the platform wallet can't receive them, and assets skipped because Horizon failed.
  const skipped = warn.mock.calls.filter((c) => c[1] === "platform_fee_in_xlm_fallback").map((c) => c[0].asset);
  const horizonSkipped = warn.mock.calls.filter((c) => c[1] === "platform_fee_skipped" && c[0].reason === "horizon").map((c) => c[0].asset);
  return { tx: r.finalTx as StellarSdk.Transaction, fees: (r.feeDetails?.feeOperations ?? []) as any[], skipped, horizonSkipped };
}

const send = (asset: StellarSdk.Asset, sendAmount: string, destMin = "1") =>
  StellarSdk.Operation.pathPaymentStrictSend({ sendAsset: asset, sendAmount, destination: user, destAsset: asset.isNative() ? usdc : XLM, destMin });
const recv = (asset: StellarSdk.Asset, sendMax: string, destAmount = "100") =>
  StellarSdk.Operation.pathPaymentStrictReceive({ sendAsset: asset, sendMax, destination: user, destAsset: asset.isNative() ? usdc : XLM, destAmount });

const stroops = (s: string) => BigInt(s.replace(".", ""));

describe("platform fee on swaps (sign-and-submit)", () => {
  it("strictSend in XLM: fee comes out of sendAmount, destMin is kept, total spend unchanged", async () => {
    const orig = build([send(XLM, "100", "40")], "100", StellarSdk.Memo.text("m-1"));
    const { tx } = await charge(orig, 0.1);
    const ops = tx.operations as any[];
    expect(ops.map((o) => o.type)).toEqual(["pathPaymentStrictSend", "payment"]);
    expect(ops[0].sendAmount).toBe("99.9000000");
    expect(ops[0].destMin).toBe("40.0000000");
    expect(ops[1].destination).toBe(platform);
    expect(ops[1].asset.isNative()).toBe(true);
    expect(ops[1].amount).toBe("0.1000000");
    expect(stroops(ops[0].sendAmount) + stroops(ops[1].amount)).toBe(stroops("100.0000000"));
    expect(tx.sequence).toBe(orig.sequence);
    expect(tx.memo.value!.toString()).toBe("m-1");
  });

  it("strictSend in an issued asset: fee is paid in that asset (code and issuer)", async () => {
    const { tx } = await charge(build([send(usdc, "250")]), 0.1, horizonWith(line(usdc)));
    const ops = tx.operations as any[];
    expect(ops[0].sendAmount).toBe("249.7500000");
    expect(ops[1].asset.getCode()).toBe("USDC");
    expect(ops[1].asset.getIssuer()).toBe(issuer);
    expect(ops[1].amount).toBe("0.2500000");
  });

  it("strictReceive: fee comes out of the sendMax budget, destAmount unchanged, total never above sendMax", async () => {
    const { tx } = await charge(build([recv(XLM, "120", "100")]), 0.1);
    const ops = tx.operations as any[];
    expect(ops.map((o) => o.type)).toEqual(["pathPaymentStrictReceive", "payment"]);
    expect(ops[0].destAmount).toBe("100.0000000");
    expect(ops[0].sendMax).toBe("119.8800000");
    expect(ops[1].amount).toBe("0.1200000");
    expect(ops[1].asset.isNative()).toBe(true);
    expect(stroops(ops[0].sendMax) + stroops(ops[1].amount)).toBe(stroops("120.0000000"));
  });

  it("mixed transaction: changeTrust untouched, the direct payment pays on top, the swap within its amount", async () => {
    const trust = StellarSdk.Operation.changeTrust({ asset: usdc, limit: "500" });
    const pay = StellarSdk.Operation.payment({ destination: dest, asset: XLM, amount: "3" });
    const { tx } = await charge(build([trust, pay, send(XLM, "10")]), 0.1);
    const ops = tx.operations as any[];
    expect(ops.map((o) => o.type)).toEqual(["changeTrust", "payment", "pathPaymentStrictSend", "payment"]);
    expect(ops[0].limit).toBe("500.0000000");
    expect(ops[1].amount).toBe("3.0000000");
    expect(ops[1].destination).toBe(dest);
    expect(ops[2].sendAmount).toBe("9.9900000");
    // 0.003 (payment, on top) + 0.01 (swap, within)
    expect(ops[3].amount).toBe("0.0130000");
    expect(ops[3].destination).toBe(platform);
  });

  it("several swaps: one fee payment per asset, summed", async () => {
    const { tx, fees } = await charge(build([send(XLM, "100"), recv(XLM, "50"), send(usdc, "20")]), 0.1, horizonWith(line(usdc)));
    expect(fees).toEqual([{ asset: "XLM", amount: "0.1500000", xlmFallbackFor: [] }, { asset: "USDC", amount: "0.0200000", xlmFallbackFor: [] }]);
    const ops = tx.operations as any[];
    expect(ops.map((o) => o.type)).toEqual(["pathPaymentStrictSend", "pathPaymentStrictReceive", "pathPaymentStrictSend", "payment", "payment"]);
    expect(ops[0].sendAmount).toBe("99.9000000");
    expect(ops[1].sendMax).toBe("49.9500000");
    expect(ops[2].sendAmount).toBe("19.9800000");
    expect(ops[3].asset.isNative()).toBe(true);
    expect(ops[3].amount).toBe("0.1500000");
    expect(ops[4].asset.getCode()).toBe("USDC");
    expect(ops[4].amount).toBe("0.0200000");
  });

  it("charged operations: payments and account creation on top, swaps within; nothing else", () => {
    const ops = build([
      StellarSdk.Operation.payment({ destination: dest, asset: XLM, amount: "100" }),
      StellarSdk.Operation.createAccount({ destination: dest, startingBalance: "5" }),
      send(XLM, "10"), recv(usdc, "20"),
      StellarSdk.Operation.changeTrust({ asset: usdc }),
      StellarSdk.Operation.payment({ destination: platform, asset: XLM, amount: "1" }),
    ]).operations as any[];
    expect(planCharges(ops, 0.1, platform).map((c) => [c.opIndex, c.onTop])).toEqual([[0, true], [1, true], [2, false], [3, false]]);
  });

  it("the floor replaces the old dust skip: a tiny swap still pays (percentage, at least 1 stroop)", async () => {
    expect(planCharges(build([send(XLM, "0.002")]).operations as any[], 0.1, platform)[0].pctFee).toBe(20n);
    const { tx } = await charge(build([send(XLM, "0.0001")]), 0.1);
    const ops = tx.operations as any[];
    expect(ops[0].sendAmount).toBe("0.0000999");
    expect(ops[1].amount).toBe("0.0000001");
  });

  it("rounds the percentage down to 7 decimals, never up", async () => {
    expect(planCharges(build([send(XLM, "123.4567891")]).operations as any[], 0.1, platform)[0].pctFee).toBe(1234567n);
    expect(planCharges(build([recv(usdc, "0.9999999")]).operations as any[], 0.3, platform)[0].pctFee).toBe(29999n);
    const { tx } = await charge(build([send(XLM, "123.4567891")]), 0.1);
    expect((tx.operations as any[])[0].sendAmount).toBe("123.3333324");
  });

  it("percentage 0 (or not a sane percentage) collects nothing", async () => {
    const ops = build([send(XLM, "100"), recv(XLM, "50")]).operations as any[];
    for (const pct of [0, -1, NaN, 100, 150]) expect(planCharges(ops, pct, platform)).toEqual([]);
    const orig = build([send(XLM, "100")]);
    expect((await charge(orig, 0)).tx).toBe(orig);
  });

  it("XLM fees never need a Horizon lookup", async () => {
    const h = noHorizon();
    const { fees, skipped } = await charge(build([send(XLM, "100")]), 0.1, h);
    expect(fees).toHaveLength(1);
    expect(skipped).toEqual([]);
    expect(h.loadAccount).not.toHaveBeenCalled();
  });

  it("platform wallet without a trustline: the swap is not reduced and pays the 0.01 XLM floor in XLM", async () => {
    const h = horizonWith(line(eurc));
    const { tx, skipped } = await charge(build([send(usdc, "100")]), 0.1, h);
    const ops = tx.operations as any[];
    expect(ops.map((o) => o.type)).toEqual(["pathPaymentStrictSend", "payment"]);
    expect(ops[0].sendAmount).toBe("100.0000000");
    expect(ops[1].asset.isNative()).toBe(true);
    expect(ops[1].amount).toBe("0.0100000");
    expect(skipped).toEqual(["USDC"]);
    expect(h.loadAccount).toHaveBeenCalledWith(platform);
  });

  it("Horizon fails: no fee for that asset (machinery), other assets still charged; unauthorised, full or summed-over trustline: XLM floor", async () => {
    const failing = { loadAccount: vi.fn(async () => { throw new Error("timeout"); }) };
    let r = await charge(build([send(XLM, "100"), send(usdc, "100")]), 0.1, failing);
    expect(r.horizonSkipped).toEqual(["USDC"]);
    expect((r.tx.operations as any[]).map((o) => o.type)).toEqual(["pathPaymentStrictSend", "pathPaymentStrictSend", "payment"]);
    expect((r.tx.operations as any[])[1].sendAmount).toBe("100.0000000");
    expect((r.tx.operations as any[])[2].asset.isNative()).toBe(true);
    expect((r.tx.operations as any[])[2].amount).toBe("0.1000000");

    r = await charge(build([send(usdc, "100")]), 0.1, horizonWith(line(usdc, { is_authorized: false })));
    expect(r.skipped).toEqual(["USDC"]);
    // room left: limit 10 - balance 9.95 - buying 0 = 0.05 < 0.1 fee
    r = await charge(build([send(usdc, "100")]), 0.1, horizonWith(line(usdc, { limit: "10.0000000", balance: "9.9500000" })));
    expect(r.skipped).toEqual(["USDC"]);
    // the room check uses the summed fee for the asset: 0.06 + 0.06 > 0.1 room
    r = await charge(build([send(usdc, "60"), send(usdc, "60")]), 0.1, horizonWith(line(usdc, { limit: "10.0000000", balance: "9.9000000" })));
    expect(r.skipped).toEqual(["USDC"]);
    r = await charge(build([send(usdc, "100")]), 0.1, horizonWith(line(usdc, { limit: "10.0000000", balance: "9.9000000" })));
    expect(r.skipped).toEqual([]);
    expect(r.fees).toEqual([{ asset: "USDC", amount: "0.1000000", xlmFallbackFor: [] }]);
  });

  it("an asset issued by the platform wallet itself needs no trustline", async () => {
    const own = new StellarSdk.Asset("AMMA", platform);
    const h = noHorizon();
    const { fees, skipped } = await charge(build([send(own, "100")]), 0.1, h);
    expect(fees).toHaveLength(1);
    expect(skipped).toEqual([]);
    expect(h.loadAccount).not.toHaveBeenCalled();
  });

  it("keeps the client's per-operation network fee rate when operations are added", () => {
    const two = build([StellarSdk.Operation.changeTrust({ asset: usdc }), send(XLM, "1")], "150");
    expect(two.fee).toBe("300");
    expect(perOpFee(two)).toBe("150");
  });
});

describe("sign-and-submit fee step (source)", () => {
  const lib = readFileSync(join(__dirname, "platform-fee.ts"), "utf-8");
  const src = serverSource();
  const block = src.slice(src.indexOf("── Platform Fee Injection ──"), src.indexOf("// Only this call is mapped to a Horizon message"));

  it("uses the shared fee helpers and logs the stable skip warning", () => {
    expect(lib).toContain("planCharges(ops, feePercent, platformWallet)");
    expect(lib).toContain("settleFees(");
    expect(lib).toContain('"platform_fee_skipped"');
    // path payments are read by sendAmount / sendMax (the old detection read op.amount and never matched)
    expect(lib).not.toMatch(/pathPayment[^\n]*op\.amount/);
  });

  it("does not add the platform key's signature to the user's inner transaction (it would be an unused signature)", () => {
    expect(block).not.toMatch(/finalTx\.sign\(platformKeypair\)/);
    expect(lib).not.toMatch(/finalTx\.sign\(/);
  });
});
