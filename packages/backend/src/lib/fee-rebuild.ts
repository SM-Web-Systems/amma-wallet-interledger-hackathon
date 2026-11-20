import * as StellarSdk from "@stellar/stellar-sdk";
import Decimal from "decimal.js";

const Money = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_DOWN });
const ONE = 10_000_000n; // stroops per unit (7 decimals)

export const toStroops = (amount: string): bigint => BigInt(new Money(amount).mul(1e7).toFixed(0, Decimal.ROUND_DOWN));
export const fromStroops = (s: bigint): string => `${s / ONE}.${(s % ONE).toString().padStart(7, "0")}`;
export const assetKey = (a: StellarSdk.Asset): string => (a.isNative() ? "native" : `${a.getCode()}:${a.getIssuer()}`);

/** One charged (outgoing) operation. `onTop`: the fee is an extra payment (payment, createAccount); otherwise it is taken out of the swap's approved amount. */
export type Charge = { opIndex: number; asset: StellarSdk.Asset; onTop: boolean; base: bigint; pctFee: bigint };

const pctOf = (base: bigint, feePercent: number): bigint => BigInt(new Money(base.toString()).mul(feePercent).div(100).toFixed(0, Decimal.ROUND_DOWN));

/**
 * The operations that pay the platform fee: every send out of the wallet.
 * - payment, createAccount: fee ON TOP (the recipient gets exactly the amount typed).
 * - pathPaymentStrictSend (sendAmount) / pathPaymentStrictReceive (sendMax): fee WITHIN the approved amount.
 * Nothing else pays (changeTrust, setOptions, manageData, claims, ...), and nothing paid to the platform wallet itself.
 * pctFee is the percentage in stroops, rounded down.
 */
export function planCharges(ops: any[], feePercent: number, platformWallet: string): Charge[] {
  if (!(feePercent > 0 && feePercent < 100)) return [];
  const out: Charge[] = [];
  ops.forEach((op, opIndex) => {
    if (op.destination === platformWallet) return;
    let asset: StellarSdk.Asset, amount: string, onTop: boolean;
    if (op.type === "payment") [asset, amount, onTop] = [op.asset, op.amount, true];
    else if (op.type === "createAccount") [asset, amount, onTop] = [StellarSdk.Asset.native(), op.startingBalance, true];
    else if (op.type === "pathPaymentStrictSend") [asset, amount, onTop] = [op.sendAsset, op.sendAmount, false];
    else if (op.type === "pathPaymentStrictReceive") [asset, amount, onTop] = [op.sendAsset, op.sendMax, false];
    else return;
    const base = toStroops(amount);
    out.push({ opIndex, asset, onTop, base, pctFee: pctOf(base, feePercent) });
  });
  return out;
}

/** Can the platform wallet take `amount` of this issued asset: yes, no (no/unauthorised/full trustline), or unknown (Horizon failed). */
export type Receivable = "ok" | "no" | "unknown";
export type FeePlan = {
  /** Swap operations to rebuild with a smaller amount. */
  reduce: { opIndex: number; netAmount: string }[];
  /** One payment to the platform wallet per asset. */
  payments: { asset: StellarSdk.Asset; amount: string }[];
  notes: { unpriced: { asset: string; reason: string }[]; xlmFallback: string[]; floorCapped: string[]; horizon: string[] };
};

/**
 * Fee per asset = max(sum of the percentages, floor). The floor is `xlmFloor` for XLM and `floorOf(asset)` (the asset's value of
 * that many XLM) for an issued asset; with no usable price the floor is 1 stroop. A quoted floor above 5% of what is sent in that
 * asset is not trusted (thin order book): percentage only. The floor top-up goes on top when the asset has a
 * direct send, else into the largest swap if it still leaves something to swap. An issued asset the platform can't receive pays the
 * XLM floor in XLM instead; if that can't be known (Horizon failed) that asset pays nothing.
 */
export function settleFees(
  charges: Charge[],
  o: { xlmFloor: bigint; floorOf: (a: StellarSdk.Asset) => bigint | { reason: string }; receivable: (a: StellarSdk.Asset, amount: bigint) => Receivable },
): FeePlan {
  const plan: FeePlan = { reduce: [], payments: [], notes: { unpriced: [], xlmFallback: [], floorCapped: [], horizon: [] } };
  const groups = new Map<string, Charge[]>();
  for (const c of charges) groups.set(assetKey(c.asset), [...(groups.get(assetKey(c.asset)) ?? []), c]);
  const xlmFloor = o.xlmFloor > 1n ? o.xlmFloor : 1n;
  const sums = new Map<string, { asset: StellarSdk.Asset; stroops: bigint }>();
  const add = (asset: StellarSdk.Asset, s: bigint) => sums.set(assetKey(asset), { asset, stroops: (sums.get(assetKey(asset))?.stroops ?? 0n) + s });

  for (const group of groups.values()) {
    const asset = group[0].asset;
    const code = asset.isNative() ? "XLM" : asset.getCode();
    const sent = group.reduce((t, c) => t + c.base, 0n);
    let floor = xlmFloor;
    if (!asset.isNative()) {
      const q = o.floorOf(asset);
      if (typeof q !== "bigint") { plan.notes.unpriced.push({ asset: code, reason: q.reason }); floor = 1n; }
      else if (q * 20n > sent) { plan.notes.unpriced.push({ asset: code, reason: "thin_book" }); floor = 1n; }
      else floor = q > 1n ? q : 1n;
    }
    const fee = new Map(group.map((c) => [c.opIndex, c.pctFee]));
    const total = group.reduce((t, c) => t + c.pctFee, 0n);
    if (total < floor) {
      const deficit = floor - total;
      const onTop = group.find((c) => c.onTop);
      if (onTop) fee.set(onTop.opIndex, fee.get(onTop.opIndex)! + deficit);
      else {
        const largest = group.reduce((a, c) => (c.base > a.base ? c : a));
        if (fee.get(largest.opIndex)! + deficit < largest.base) fee.set(largest.opIndex, fee.get(largest.opIndex)! + deficit);
        else {
          plan.notes.floorCapped.push(code);
          if (total === 0n && largest.base >= 2n) fee.set(largest.opIndex, 1n);
        }
      }
    }
    const amount = [...fee.values()].reduce((t, v) => t + v, 0n);
    if (amount === 0n) continue;
    if (!asset.isNative()) {
      const r = o.receivable(asset, amount);
      if (r === "unknown") { plan.notes.horizon.push(code); continue; }
      if (r === "no") { plan.notes.xlmFallback.push(code); add(StellarSdk.Asset.native(), xlmFloor); continue; }
    }
    add(asset, amount);
    for (const c of group) if (!c.onTop && fee.get(c.opIndex)! > 0n) plan.reduce.push({ opIndex: c.opIndex, netAmount: fromStroops(c.base - fee.get(c.opIndex)!) });
  }
  plan.payments = [...sums.values()].map((s) => ({ asset: s.asset, amount: fromStroops(s.stroops) }));
  plan.reduce.sort((a, b) => a.opIndex - b.opIndex);
  return plan;
}

/** The client's network fee per operation, so adding the fee payment does not multiply the bid. */
export function perOpFee(tx: StellarSdk.Transaction): string {
  const n = BigInt(Math.max(tx.operations.length, 1));
  return ((BigInt(tx.fee) + n - 1n) / n).toString();
}

// Re-adds the original operations to a builder, reducing the amount of the fee-bearing ones.
// Moved out of server.ts (sign-and-submit) so it can be tested.
// Operations that are copied as they are come from xdrOps[i] (the original XDR operations).
// The old code called `op.toXDRObject()` there: `op` was out of scope in one branch, and parsed
// SDK operations have no toXDRObject method in any case, so it threw and the fee was skipped.
export function addOpsWithFeeAdjustments(
  builder: StellarSdk.TransactionBuilder,
  ops: any[],
  feeOps: { opIndex: number; netAmount: string }[],
  xdrOps: StellarSdk.xdr.Operation[],
): void {
  for (let i = 0; i < ops.length; i++) {
    const feeOp = feeOps.find((f) => f.opIndex === i);
    if (feeOp) {
      // Rebuild this op with reduced amount
      const op = ops[i];
      if (op.type === "payment") {
        builder.addOperation(
          StellarSdk.Operation.payment({
            destination: op.destination,
            asset: op.asset,
            amount: feeOp.netAmount,
            source: op.source || undefined,
          }),
        );
      } else if (op.type === "pathPaymentStrictSend") {
        builder.addOperation(
          StellarSdk.Operation.pathPaymentStrictSend({
            sendAsset: op.sendAsset,
            sendAmount: feeOp.netAmount,
            destination: op.destination,
            destAsset: op.destAsset,
            destMin: op.destMin,
            path: op.path || [],
            source: op.source || undefined,
          }),
        );
      } else if (op.type === "pathPaymentStrictReceive") {
        // The fee comes out of the sendMax budget: swap cap + fee never exceed what the user approved.
        builder.addOperation(
          StellarSdk.Operation.pathPaymentStrictReceive({
            sendAsset: op.sendAsset,
            sendMax: feeOp.netAmount,
            destination: op.destination,
            destAsset: op.destAsset,
            destAmount: op.destAmount,
            path: op.path || [],
            source: op.source || undefined,
          }),
        );
      } else {
        builder.addOperation(
          xdrOps[i],
        );
      }
    } else {
      builder.addOperation(
        xdrOps[i],
      );
    }
  }
}
