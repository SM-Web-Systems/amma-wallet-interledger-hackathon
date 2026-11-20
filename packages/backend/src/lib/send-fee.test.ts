import { describe, it, expect, vi, beforeEach } from "vitest";
import { serverSource } from "../test-support/server-source";
import { readFileSync } from "fs";
import { join } from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { applyPlatformFee, resetPlatformFeeCaches, MAX_PLATFORM_FEE_MIN_XLM } from "./platform-fee";
import { checkStellarTx, stellarDailyCost, type TokenCap } from "./custody-limits";

// Owner decision 18 Nov: every outgoing send pays (payment, createAccount, swaps); receives and other operations do not.
// Fee = max(percentage, floor). Floor 0.01 XLM, or its value in the asset sent. Direct sends pay the fee ON TOP.

const PASS = StellarSdk.Networks.PUBLIC;
const userKp = StellarSdk.Keypair.random();
const user = userKp.publicKey();
const platformKp = StellarSdk.Keypair.random();
const platform = platformKp.publicKey();
const dest = StellarSdk.Keypair.random().publicKey();
const issuer = StellarSdk.Keypair.random().publicKey();
const usdc = new StellarSdk.Asset("USDC", issuer);
const XLM = StellarSdk.Asset.native();

const line = (a: StellarSdk.Asset, o: Record<string, any> = {}) => ({
  asset_type: "credit_alphanum4", asset_code: a.getCode(), asset_issuer: a.getIssuer(), balance: "0.0000000",
  limit: "922337203685.4775807", buying_liabilities: "0.0000000", is_authorized: true, ...o,
});
/** Fake Horizon: the platform account's trustlines and a strict-receive quote ("how much of the asset buys 0.01 XLM"). */
function horizon(o: { lines?: any[]; quotes?: string[] | Error; failAccount?: boolean } = {}) {
  return {
    loadAccount: vi.fn(async (_id: string) => {
      if (o.failAccount) throw new Error("horizon down");
      return { balances: [{ asset_type: "native", balance: "50.0000000" }, ...(o.lines ?? [line(usdc)])] };
    }),
    strictReceivePaths: vi.fn((_src: StellarSdk.Asset[], _dst: StellarSdk.Asset, _amt: string) => ({
      call: async () => {
        if (o.quotes instanceof Error) throw o.quotes;
        return { records: (o.quotes ?? ["0.0030000", "0.0025000"]).map((s) => ({ source_amount: s })) };
      },
    })),
  };
}
const warn = vi.fn();
const opts = (h: any = horizon(), extra: Record<string, any> = {}) => ({
  feePercent: 0.1, minFeeXlm: 0.01, platformWallet: platform, platformSecret: platformKp.secret(), source: user,
  passphrase: PASS, horizon: h, warn, ...extra,
});
function build(ops: StellarSdk.xdr.Operation[], memo?: StellarSdk.Memo) {
  const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(user, "41"), { fee: "100", networkPassphrase: PASS });
  ops.forEach((op) => b.addOperation(op));
  if (memo) b.addMemo(memo);
  return StellarSdk.TransactionBuilder.fromXDR(b.setTimeout(60).build().toXDR(), PASS) as StellarSdk.Transaction;
}
const pay = (amount: string, asset = XLM, destination = dest) => StellarSdk.Operation.payment({ destination, asset, amount });
const create = (startingBalance: string) => StellarSdk.Operation.createAccount({ destination: dest, startingBalance });
const swap = (asset: StellarSdk.Asset, sendAmount: string, destMin = "1") =>
  StellarSdk.Operation.pathPaymentStrictSend({ sendAsset: asset, sendAmount, destination: user, destAsset: asset.isNative() ? usdc : XLM, destMin });
const opsOf = async (tx: StellarSdk.Transaction, h: any = horizon(), extra: Record<string, any> = {}) => {
  const r = await applyPlatformFee(tx, opts(h, extra));
  return { ops: (r.finalTx as StellarSdk.Transaction).operations as any[], r };
};
const warned = (msg: string) => warn.mock.calls.filter((c) => c[1] === msg).map((c) => c[0]);

beforeEach(() => { resetPlatformFeeCaches(); warn.mockReset(); });

describe("direct sends pay the fee on top; the recipient gets exactly what was typed", () => {
  it("10 XLM payment: 0.1% = 0.01 XLM extra payment to the platform", async () => {
    const { ops, r } = await opsOf(build([pay("10")], StellarSdk.Memo.text("m")));
    expect(ops.map((o) => o.type)).toEqual(["payment", "payment"]);
    expect(ops[0]).toMatchObject({ destination: dest, amount: "10.0000000" });
    expect(ops[1]).toMatchObject({ destination: platform, amount: "0.0100000" });
    expect(ops[1].asset.isNative()).toBe(true);
    expect((r.finalTx as StellarSdk.Transaction).memo.value!.toString()).toBe("m");
    expect(r.feeDetails.feeOperations).toEqual([{ asset: "XLM", amount: "0.0100000", xlmFallbackFor: [] }]);
    expect(r.feeDetails.minFeeXlm).toBe(0.01);
  });

  it("0.5 XLM payment: the 0.01 XLM floor applies (0.1% would be 0.0005)", async () => {
    const { ops } = await opsOf(build([pay("0.5")]));
    expect(ops[0].amount).toBe("0.5000000");
    expect(ops[1].amount).toBe("0.0100000");
  });

  it("1000 XLM payment: the percentage applies (1 XLM)", async () => {
    const { ops } = await opsOf(build([pay("1000")]));
    expect(ops[1].amount).toBe("1.0000000");
  });

  it("100 USDC payment: 0.1 USDC extra payment in USDC; the floor (0.0025 USDC) is lower", async () => {
    const h = horizon();
    const { ops } = await opsOf(build([pay("100", usdc)]), h);
    expect(ops.map((o) => o.type)).toEqual(["payment", "payment"]);
    expect(ops[0].amount).toBe("100.0000000");
    expect(ops[1]).toMatchObject({ destination: platform, amount: "0.1000000" });
    expect(ops[1].asset.getCode()).toBe("USDC");
    expect(ops[1].asset.getIssuer()).toBe(issuer);
    // quote asked: how much USDC buys 0.01 XLM; the cheapest record is used
    expect(h.strictReceivePaths).toHaveBeenCalledWith([usdc], XLM, "0.0100000");
  });

  it("1 USDC payment: the floor in USDC applies (cheapest quote 0.0025 USDC > 0.001)", async () => {
    const { ops } = await opsOf(build([pay("1", usdc)]));
    expect(ops[0].amount).toBe("1.0000000");
    expect(ops[1].amount).toBe("0.0025000");
  });

  it("createAccount pays on top in XLM; startingBalance unchanged", async () => {
    let { ops } = await opsOf(build([create("5")]));
    expect(ops.map((o) => o.type)).toEqual(["createAccount", "payment"]);
    expect(ops[0].startingBalance).toBe("5.0000000");
    expect(ops[1]).toMatchObject({ destination: platform, amount: "0.0100000" });
    ({ ops } = await opsOf(build([create("2000")])));
    expect(ops[1].amount).toBe("2.0000000");
  });

  it("a payment to the platform wallet itself is not charged", async () => {
    const tx = build([pay("5", XLM, platform)]);
    expect((await applyPlatformFee(tx, opts())).finalTx).toBe(tx);
  });
});

describe("floor price for issued assets", () => {
  it("no price (quote fails or no path): percentage only, logged with the asset code", async () => {
    let { ops } = await opsOf(build([pay("1", usdc)]), horizon({ quotes: new Error("no path") }));
    expect(ops[1].amount).toBe("0.0010000");
    expect(warned("platform_fee_floor_unpriced")).toEqual([{ asset: "USDC", reason: "no_price" }]);
    warn.mockReset(); resetPlatformFeeCaches();
    ({ ops } = await opsOf(build([pay("1", usdc)]), horizon({ quotes: [] })));
    expect(ops[1].amount).toBe("0.0010000");
    expect(warned("platform_fee_floor_unpriced")).toEqual([{ asset: "USDC", reason: "no_price" }]);
  });

  it("a quote that never answers is cut off; the send still goes, percentage only", async () => {
    const h = horizon();
    h.strictReceivePaths.mockReturnValue({ call: () => new Promise<never>(() => {}) } as any);
    const { ops } = await opsOf(build([pay("1", usdc)]), h, { timeoutMs: 20 });
    expect(ops[1].amount).toBe("0.0010000");
  });

  it("unpriced and tiny: still at least 1 stroop (always a charge)", async () => {
    const { ops } = await opsOf(build([pay("0.0001", usdc)]), horizon({ quotes: [] }));
    expect(ops[1].amount).toBe("0.0000001");
  });

  it("an implausible quote (floor above the amount sent) is not used", async () => {
    const { ops } = await opsOf(build([pay("1", usdc)]), horizon({ quotes: ["5.0000000"] }));
    expect(ops[1].amount).toBe("0.0010000");
    expect(warned("platform_fee_floor_unpriced")).toEqual([{ asset: "USDC", reason: "thin_book" }]);
  });

  it("XLM-only transactions make no Horizon call", async () => {
    const h = horizon();
    await opsOf(build([pay("3"), create("2")]), h);
    expect(h.loadAccount).not.toHaveBeenCalled();
    expect(h.strictReceivePaths).not.toHaveBeenCalled();
  });
});

describe("platform wallet cannot receive the asset: 0.01 XLM floor in XLM instead", () => {
  for (const [name, lines] of [
    ["no trustline", []],
    ["unauthorised trustline", [line(usdc, { is_authorized: false })]],
    ["trustline full", [line(usdc, { limit: "1.0000000", balance: "0.9999999" })]],
  ] as const) {
    it(name, async () => {
      const { ops } = await opsOf(build([pay("100", usdc)]), horizon({ lines: [...lines] as any[] }));
      expect(ops.map((o) => o.type)).toEqual(["payment", "payment"]);
      expect(ops[0].amount).toBe("100.0000000");
      expect(ops[0].asset.getCode()).toBe("USDC");
      expect(ops[1].asset.isNative()).toBe(true);
      expect(ops[1]).toMatchObject({ destination: platform, amount: "0.0100000" });
      expect(warned("platform_fee_in_xlm_fallback")).toEqual([{ asset: "USDC" }]);
    });
  }

  it("a swap in that asset is then not reduced; the XLM floor comes on top", async () => {
    const { ops } = await opsOf(build([swap(usdc, "50")]), horizon({ lines: [] }));
    expect(ops[0].sendAmount).toBe("50.0000000");
    expect(ops[1].asset.isNative()).toBe(true);
    expect(ops[1].amount).toBe("0.0100000");
  });

  it("the XLM fallback is added to the XLM fee of the same transaction (one XLM payment)", async () => {
    const { ops } = await opsOf(build([pay("100"), pay("100", usdc)]), horizon({ lines: [] }));
    expect(ops.map((o) => o.type)).toEqual(["payment", "payment", "payment"]);
    expect(ops[2].asset.isNative()).toBe(true);
    expect(ops[2].amount).toBe("0.1100000");
  });

  it("platform account read fails (machinery): no fee for that asset, XLM sends still charged", async () => {
    const { ops } = await opsOf(build([pay("100"), pay("100", usdc)]), horizon({ failAccount: true }));
    expect(ops.map((o) => o.type)).toEqual(["payment", "payment", "payment"]);
    expect(ops[2].asset.isNative()).toBe(true);
    expect(ops[2].amount).toBe("0.1000000");
    expect(warned("platform_fee_skipped")).toEqual([{ reason: "horizon", asset: "USDC" }]);
  });
});

describe("swaps: fee within the approved amount, always charged", () => {
  it("5 XLM strict-send swap: floor 0.01 XLM taken out of the 5 XLM; destMin kept", async () => {
    const { ops } = await opsOf(build([swap(XLM, "5", "0.99")]));
    expect(ops[0].sendAmount).toBe("4.9900000");
    expect(ops[0].destMin).toBe("0.9900000");
    expect(ops[1].amount).toBe("0.0100000");
  });

  it("thin slippage: still charged (owner decision); the swap may then fail and the user widens slippage", async () => {
    const { ops } = await opsOf(build([swap(XLM, "100", "99.99")]));
    expect(ops[0].sendAmount).toBe("99.9000000");
    expect(ops[0].destMin).toBe("99.9900000");
  });

  it("a swap smaller than the floor: percentage only (the floor would take the whole swap)", async () => {
    const { ops } = await opsOf(build([swap(XLM, "0.005")]));
    expect(ops[0].sendAmount).toBe("0.0049950");
    expect(ops[1].amount).toBe("0.0000050");
    expect(warned("platform_fee_floor_capped")).toEqual([{ asset: "XLM" }]);
  });
});

describe("no fee on anything that is not a send", () => {
  it("changeTrust, setOptions, manageData, claimClaimableBalance: transaction untouched, no Horizon call, no warning", async () => {
    const h = horizon();
    for (const op of [
      StellarSdk.Operation.changeTrust({ asset: usdc }),
      StellarSdk.Operation.setOptions({ homeDomain: "amma.example" }),
      StellarSdk.Operation.manageData({ name: "k", value: "v" }),
      StellarSdk.Operation.claimClaimableBalance({ balanceId: "00000000" + "a".repeat(64) }),
    ]) {
      const tx = build([op]);
      const r = await applyPlatformFee(tx, opts(h));
      expect(r.finalTx).toBe(tx);
      expect(r.feeDetails).toBeNull();
    }
    expect(h.loadAccount).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a mixed transaction charges only its send operations", async () => {
    const { ops } = await opsOf(build([StellarSdk.Operation.changeTrust({ asset: usdc }), pay("20")]));
    expect(ops.map((o) => o.type)).toEqual(["changeTrust", "payment", "payment"]);
    expect(ops[2].amount).toBe("0.0200000");
  });
});

describe("several operations: one fee payment per asset, floor once per asset", () => {
  it("two XLM payments 3 + 4: percentage 0.007 lifts to one 0.01 floor", async () => {
    const { ops } = await opsOf(build([pay("3"), pay("4")]));
    expect(ops.map((o) => o.amount)).toEqual(["3.0000000", "4.0000000", "0.0100000"]);
  });
  it("20 + 30 XLM: 0.05 XLM; plus 100 USDC: separate 0.1 USDC payment", async () => {
    const { ops } = await opsOf(build([pay("20"), pay("30"), pay("100", usdc)]));
    expect(ops.slice(3).map((o) => [o.asset.isNative() ? "XLM" : o.asset.getCode(), o.amount])).toEqual([["XLM", "0.0500000"], ["USDC", "0.1000000"]]);
  });
  it("swap and payment in XLM: swap reduced by its own percentage, the floor top-up goes on top", async () => {
    const { ops } = await opsOf(build([swap(XLM, "2"), pay("3")]));
    expect(ops[0].sendAmount).toBe("1.9980000");
    expect(ops[1].amount).toBe("3.0000000");
    expect(ops[2].amount).toBe("0.0100000");
  });
});

describe("off switches and bad settings charge nothing", () => {
  it("percentage 0, wallet unset, secret unset", async () => {
    const tx = build([pay("100")]);
    for (const extra of [{ feePercent: 0 }, { platformWallet: "" }, { platformSecret: "" }]) {
      expect((await applyPlatformFee(tx, opts(horizon(), extra))).finalTx).toBe(tx);
    }
  });
  it(`minimum above ${MAX_PLATFORM_FEE_MIN_XLM} XLM, negative or not a number: nothing charged`, async () => {
    expect(MAX_PLATFORM_FEE_MIN_XLM).toBe(1);
    const tx = build([pay("100")]);
    for (const minFeeXlm of [1.5, -1, NaN]) expect((await applyPlatformFee(tx, opts(horizon(), { minFeeXlm }))).finalTx).toBe(tx);
    expect((await applyPlatformFee(tx, opts(horizon(), { minFeeXlm: 1 }))).feeDetails).not.toBeNull();
  });
  it("minimum 0: percentage only, still at least 1 stroop", async () => {
    let { ops } = await opsOf(build([pay("10")]), horizon(), { minFeeXlm: 0 });
    expect(ops[1].amount).toBe("0.0100000");
    ({ ops } = await opsOf(build([pay("0.0001")]), horizon(), { minFeeXlm: 0 }));
    expect(ops[1].amount).toBe("0.0000001");
  });
});

describe("retries and custody caps", () => {
  it("the same payment envelope rebuilds to the same hash, even if the quote changes", async () => {
    const xdr = build([pay("1", usdc)]).toXDR();
    const a = await applyPlatformFee(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), opts(horizon()));
    const h2 = horizon({ quotes: ["0.0090000"] });
    const b = await applyPlatformFee(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), opts(h2));
    expect(a.finalTx.hash().toString("hex")).toBe(b.finalTx.hash().toString("hex"));
    expect(h2.strictReceivePaths).not.toHaveBeenCalled();
  });

  it("the fee is outflow: it counts toward the per-transaction XLM cap and the daily cost", async () => {
    const cap = 10n * 10_000_000n;
    const at = (await applyPlatformFee(build([pay("10")]), opts())).finalTx as StellarSdk.Transaction;
    expect(checkStellarTx(cap, at.operations as any, { wallet: user, feeStroops: BigInt(at.fee), tokens: new Map() })?.limit).toBe("tx");
    const under = (await applyPlatformFee(build([pay("9.99")]), opts())).finalTx as StellarSdk.Transaction;
    expect(checkStellarTx(cap, under.operations as any, { wallet: user, feeStroops: BigInt(under.fee), tokens: new Map() })).toBeNull();
    expect(stellarDailyCost(under.operations as any, BigInt(under.fee))).toBe(99_900_000n + 100_000n + 200n);
  });

  it("an issued-asset fee counts toward that token class's cap", async () => {
    const tokens = new Map<string, TokenCap>([[`USDC:${issuer}`, { code: "USDC", issuer, cls: "usd", txUnits: 100n * 10_000_000n, dayUnits: 500n * 10_000_000n }]]);
    const at = (await applyPlatformFee(build([pay("100", usdc)]), opts())).finalTx as StellarSdk.Transaction;
    expect(checkStellarTx(10n ** 12n, at.operations as any, { wallet: user, feeStroops: BigInt(at.fee), tokens })?.error).toMatch(/USD limit/);
    const under = (await applyPlatformFee(build([pay("99", usdc)]), opts())).finalTx as StellarSdk.Transaction;
    expect(checkStellarTx(10n ** 12n, under.operations as any, { wallet: user, feeStroops: BigInt(under.fee), tokens })).toBeNull();
  });
});

describe("wiring (source)", () => {
  const src = serverSource();
  const cfg = readFileSync(join(__dirname, "..", "config", "index.ts"), "utf-8");
  it("the route passes the minimum and logs machinery errors as platform_fee_skipped", () => {
    expect(src).toContain("minFeeXlm: config.PLATFORM_FEE_MIN_XLM");
    expect(src).toContain("feeForSubmit(tx, expectedHash, {");
    expect(readFileSync(join(__dirname, "platform-fee.ts"), "utf-8")).toMatch(/reason: "error"[^\n]*"platform_fee_skipped"/);
    expect(src).toContain('"platform_fee_min_over_ceiling');
  });
  it("PLATFORM_FEE_MIN_XLM defaults to 0.01", () => {
    expect(cfg).toContain('PLATFORM_FEE_MIN_XLM: parseFloat(process.env.PLATFORM_FEE_MIN_XLM || "0.01")');
  });
});
