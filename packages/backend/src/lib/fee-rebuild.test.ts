import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { addOpsWithFeeAdjustments } from "./fee-rebuild";

const kp = StellarSdk.Keypair.random();
const dest = StellarSdk.Keypair.random().publicKey();
const platform = StellarSdk.Keypair.random().publicKey();
const usdc = new StellarSdk.Asset("USDC", kp.publicKey());

function build(ops: StellarSdk.xdr.Operation[], memo?: StellarSdk.Memo) {
  const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(kp.publicKey(), "41"), {
    fee: "100",
    networkPassphrase: StellarSdk.Networks.PUBLIC,
  });
  ops.forEach((o) => b.addOperation(o));
  if (memo) b.addMemo(memo);
  return b.setTimeout(30).build();
}

// Mirrors the server: original ops are re-added, then the platform fee payment is appended.
function rebuild(orig: StellarSdk.Transaction, feeOps: any[]) {
  const builder = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account(kp.publicKey(), (BigInt(orig.sequence) - 1n).toString()),
    { fee: orig.fee, networkPassphrase: StellarSdk.Networks.PUBLIC },
  );
  addOpsWithFeeAdjustments(builder, orig.operations as any[], feeOps, orig.toEnvelope().v1().tx().operations());
  for (const f of feeOps) {
    builder.addOperation(StellarSdk.Operation.payment({ destination: platform, asset: f.asset, amount: f.amount }));
  }
  if (orig.memo && orig.memo.type !== "none") builder.addMemo(orig.memo);
  return builder.setTimeout(300).build();
}

const swap = () =>
  StellarSdk.Operation.pathPaymentStrictSend({
    sendAsset: StellarSdk.Asset.native(),
    sendAmount: "100",
    destination: dest,
    destAsset: usdc,
    destMin: "1",
  });

describe("addOpsWithFeeAdjustments on a mixed transaction", () => {
  it("keeps the other op unchanged and still adds the platform fee (fee op first)", () => {
    const trust = StellarSdk.Operation.changeTrust({ asset: usdc, limit: "500" });
    const orig = build([swap(), trust], StellarSdk.Memo.text("dep-42"));
    const out = rebuild(orig, [
      { opIndex: 0, netAmount: "99.5000000", amount: "0.5000000", asset: StellarSdk.Asset.native() },
    ]);
    const ops = out.operations as any[];
    expect(ops.map((o) => o.type)).toEqual(["pathPaymentStrictSend", "changeTrust", "payment"]);
    expect(ops[0].sendAmount).toBe("99.5000000");
    expect(ops[1].line.getCode()).toBe("USDC");
    expect(ops[1].limit).toBe("500.0000000");
    expect(ops[2].destination).toBe(platform);
    expect(ops[2].amount).toBe("0.5000000");
    // memo and sequence handling are identical to a non-mixed rebuild
    expect(out.memo.value!.toString()).toBe("dep-42");
    expect(out.sequence).toBe(orig.sequence);
  });

  it("keeps a non-fee payment that comes before the fee op", () => {
    const pay = StellarSdk.Operation.payment({ destination: dest, asset: StellarSdk.Asset.native(), amount: "3" });
    const orig = build([pay, swap()]);
    const out = rebuild(orig, [
      { opIndex: 1, netAmount: "99.5000000", amount: "0.5000000", asset: StellarSdk.Asset.native() },
    ]);
    const ops = out.operations as any[];
    expect(ops.map((o) => o.type)).toEqual(["payment", "pathPaymentStrictSend", "payment"]);
    expect(ops[0].amount).toBe("3.0000000");
    expect(ops[1].sendAmount).toBe("99.5000000");
    expect(ops[2].destination).toBe(platform);
  });

  it("pathPaymentStrictReceive: the fee comes out of sendMax, destAmount is kept (no longer on top)", () => {
    const recv = StellarSdk.Operation.pathPaymentStrictReceive({
      sendAsset: StellarSdk.Asset.native(),
      sendMax: "120",
      destination: dest,
      destAsset: usdc,
      destAmount: "100",
    });
    const orig = build([recv]);
    const out = rebuild(orig, [
      { opIndex: 0, netAmount: "119.8800000", amount: "0.1200000", asset: StellarSdk.Asset.native() },
    ]);
    const ops = out.operations as any[];
    expect(ops[0].destAmount).toBe("100.0000000");
    expect(ops[0].sendMax).toBe("119.8800000");
  });

  it("an SDK path payment has no .amount, so the server's fee detection never matches it", () => {
    const orig = build([swap()]);
    expect((orig.operations[0] as any).amount).toBeUndefined();
  });
});
