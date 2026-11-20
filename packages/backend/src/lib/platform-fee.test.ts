import { describe, it, expect, vi, beforeEach } from "vitest";
import { serverSource } from "../test-support/server-source";
import { readFileSync } from "fs";
import { join } from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { applyPlatformFee, feeBumpFor, resetPlatformFeeCaches, MAX_PLATFORM_FEE_PERCENT, PLATFORM_ACCOUNT_TIMEOUT_MS } from "./platform-fee";
import { checkStellarTx } from "./custody-limits";

const PASS = StellarSdk.Networks.PUBLIC;
const userKp = StellarSdk.Keypair.random();
const user = userKp.publicKey();
const platformKp = StellarSdk.Keypair.random();
const platform = platformKp.publicKey();
const issuer = StellarSdk.Keypair.random().publicKey();
const usdc = new StellarSdk.Asset("USDC", issuer);
const XLM = StellarSdk.Asset.native();

const line = (o: Record<string, any> = {}) => ({
  asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "0.0000000",
  limit: "922337203685.4775807", buying_liabilities: "0.0000000", is_authorized: true, ...o,
});
const horizon = (balances: any[] = []) => ({ loadAccount: vi.fn(async (_id: string) => ({ balances })) });
const warn = vi.fn();
const opts = (h: any = horizon(), extra: Record<string, any> = {}) => ({
  feePercent: 0.1, minFeeXlm: 0.01, platformWallet: platform, platformSecret: platformKp.secret(), source: user, passphrase: PASS, horizon: h, warn, ...extra,
});

const send = (asset: StellarSdk.Asset, amt = "100") =>
  StellarSdk.Operation.pathPaymentStrictSend({ sendAsset: asset, sendAmount: amt, destination: user, destAsset: asset.isNative() ? usdc : XLM, destMin: "1" });

function build(ops: StellarSdk.xdr.Operation[], o: { memo?: StellarSdk.Memo; bounds?: { minTime: number; maxTime: number } | "infinite"; extra?: (b: StellarSdk.TransactionBuilder) => void } = {}) {
  const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(user, "41"), { fee: "100", networkPassphrase: PASS });
  ops.forEach((op) => b.addOperation(op));
  if (o.memo) b.addMemo(o.memo);
  if (o.bounds === "infinite") b.setTimeout(StellarSdk.TimeoutInfinite);
  else if (o.bounds) b.setTimebounds(o.bounds.minTime, o.bounds.maxTime);
  else b.setTimeout(60);
  o.extra?.(b);
  return b.build();
}
// The client's XDR as the server receives it.
const parse = (tx: StellarSdk.Transaction) => StellarSdk.TransactionBuilder.fromXDR(tx.toXDR(), PASS) as StellarSdk.Transaction;
const hex = (t: any) => t.hash().toString("hex");

beforeEach(() => { resetPlatformFeeCaches(); warn.mockReset(); });

describe("applyPlatformFee: retries give the same envelope (WA-01)", () => {
  it("rebuilding the same original XDR twice yields the identical hash", async () => {
    const xdr = build([send(XLM)], { memo: StellarSdk.Memo.text("r-1") }).toXDR();
    const a = await applyPlatformFee(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), opts());
    const b = await applyPlatformFee(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), opts());
    expect(a.feeDetails).not.toBeNull();
    expect(hex(a.finalTx)).toBe(hex(b.finalTx));
  });

  it("the trustline decision does not flip between retries of the same envelope", async () => {
    const xdr = build([send(usdc)]).toXDR();
    const first = await applyPlatformFee(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), opts(horizon([])));
    expect(first.feeDetails.xlmFallback).toEqual(["USDC"]);
    // Trustline appears before the retry: the same envelope still gets the same answer (XLM floor, not USDC).
    const h2 = horizon([line()]);
    const retry = await applyPlatformFee(StellarSdk.TransactionBuilder.fromXDR(xdr, PASS), opts(h2));
    expect(retry.feeDetails.xlmFallback).toEqual(["USDC"]);
    expect(hex(retry.finalTx)).toBe(hex(first.finalTx));
    expect(h2.loadAccount).not.toHaveBeenCalled();
  });

  it("keeps the client's time bounds; expired bounds stay expired (no fresh window)", async () => {
    const bounds = { minTime: 1_600_000_000, maxTime: 1_600_000_060 };
    const orig = build([send(XLM)], { bounds });
    const { finalTx } = await applyPlatformFee(parse(orig), opts());
    expect((finalTx as any).operations).toHaveLength(2);
    expect((finalTx as any).timeBounds).toEqual({ minTime: "1600000000", maxTime: "1600000060" });
  });

  it("no maxTime (infinite) or other preconditions: no rebuild, submitted without the fee", async () => {
    const infinite = parse(build([send(XLM)], { bounds: "infinite" }));
    expect((await applyPlatformFee(infinite, opts())).finalTx).toBe(infinite);
    const withLedger = parse(build([send(XLM)], { extra: (b) => b.setLedgerbounds(1, 999_999_999) }));
    expect((await applyPlatformFee(withLedger, opts())).finalTx).toBe(withLedger);
    const withMinSeq = parse(build([send(XLM)], { extra: (b) => b.setMinAccountSequence("1") }));
    expect((await applyPlatformFee(withMinSeq, opts())).finalTx).toBe(withMinSeq);
    const withSigner = parse(build([send(XLM)], { extra: (b) => b.setExtraSigners([StellarSdk.Keypair.random().publicKey()]) }));
    expect((await applyPlatformFee(withSigner, opts())).finalTx).toBe(withSigner);
    expect(warn).toHaveBeenCalledWith({ reason: "preconditions" }, "platform_fee_skipped");
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("a v0 envelope fails open: submitted without the fee", async () => {
    const v1 = build([send(XLM)]);
    const env = v1.toEnvelope().v1().tx();
    const v0 = new StellarSdk.xdr.TransactionV0({
      sourceAccountEd25519: StellarSdk.StrKey.decodeEd25519PublicKey(user), fee: env.fee(), seqNum: env.seqNum(),
      timeBounds: env.cond().timeBounds(), memo: env.memo(), operations: env.operations(), ext: new (StellarSdk.xdr.TransactionV0Ext as any)(0),
    });
    const xdr = StellarSdk.xdr.TransactionEnvelope.envelopeTypeTxV0(new StellarSdk.xdr.TransactionV0Envelope({ tx: v0, signatures: [] })).toXDR("base64");
    const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, PASS);
    expect((await applyPlatformFee(tx, opts())).finalTx).toBe(tx);
    expect(warn).toHaveBeenCalledWith({ reason: "envelope_v0" }, "platform_fee_skipped");
  });
});

describe("applyPlatformFee: platform account read", () => {
  it("a Horizon read that never answers is cut off and the fee for that asset is skipped (machinery failure)", async () => {
    const hang = { loadAccount: vi.fn(() => new Promise<never>(() => {})) };
    const tx = parse(build([send(usdc)]));
    const r = await applyPlatformFee(tx, opts(hang, { timeoutMs: 20 }));
    expect(r.finalTx).toBe(tx);
    expect(warn).toHaveBeenCalledWith({ reason: "horizon", asset: "USDC" }, "platform_fee_skipped");
    expect(PLATFORM_ACCOUNT_TIMEOUT_MS).toBe(3000);
  });

  it("caches a good trustline briefly: a second, different swap needs no Horizon read", async () => {
    const h = horizon([line()]);
    let now = 1_000_000;
    await applyPlatformFee(parse(build([send(usdc, "100")])), opts(h, { now: () => now }));
    await applyPlatformFee(parse(build([send(usdc, "200")])), opts(h, { now: () => now }));
    expect(h.loadAccount).toHaveBeenCalledTimes(1);
    now += 61_000;
    await applyPlatformFee(parse(build([send(usdc, "300")])), opts(h, { now: () => now }));
    expect(h.loadAccount).toHaveBeenCalledTimes(2);
  });
});

describe("applyPlatformFee: limits", () => {
  it(`charges nothing above the ${MAX_PLATFORM_FEE_PERCENT}% ceiling`, async () => {
    expect(MAX_PLATFORM_FEE_PERCENT).toBe(1);
    const tx = parse(build([send(XLM)]));
    expect((await applyPlatformFee(tx, opts(horizon(), { feePercent: 1.5 }))).finalTx).toBe(tx);
    expect((await applyPlatformFee(tx, opts(horizon(), { feePercent: 1 }))).feeDetails).not.toBeNull();
  });

  it("skips the fee when the added operation would push the network fee over the 1 XLM custody cap", async () => {
    const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(user, "41"), { fee: "600000", networkPassphrase: PASS });
    const tx = parse(b.addOperation(send(XLM)).setTimeout(60).build()); // 600000 now, 1200000 with the fee payment
    const r = await applyPlatformFee(tx, opts());
    expect(r.finalTx).toBe(tx);
    expect(warn).toHaveBeenCalledWith({ reason: "fee_cap" }, "platform_fee_skipped");
  });
});

describe("sign-and-submit signing flow with the fee (I4)", () => {
  it("one user signature on the inner tx, platform key only on the fee bump, sequence/memo/time bounds kept, custody check passes", async () => {
    const orig = build([send(XLM, "50")], { memo: StellarSdk.Memo.text("dep-7"), bounds: { minTime: 0, maxTime: 4_000_000_000 } });
    const { finalTx, feeDetails } = await applyPlatformFee(parse(orig), opts());
    expect(feeDetails).not.toBeNull();
    const inner = finalTx as StellarSdk.Transaction;
    inner.sign(userKp); // what the route does with the user's key
    const bump = feeBumpFor(inner, platformKp.secret(), PASS);

    expect(inner.signatures).toHaveLength(1);
    expect(userKp.verify(inner.hash(), inner.signatures[0].signature())).toBe(true);
    expect(bump.signatures).toHaveLength(1);
    expect(platformKp.verify(bump.hash(), bump.signatures[0].signature())).toBe(true);
    expect(bump.feeSource).toBe(platform);
    expect(hex(bump.innerTransaction)).toBe(hex(inner));

    expect(inner.sequence).toBe(orig.sequence);
    expect(inner.memo.value!.toString()).toBe("dep-7");
    expect(inner.timeBounds).toEqual({ minTime: "0", maxTime: "4000000000" });
    expect(inner.fee).toBe("200");
    expect(checkStellarTx(1_000n * 10_000_000n, inner.operations as any, { wallet: user, feeStroops: BigInt(inner.fee), tokens: new Map() })).toBeNull();
  });

  it("server.ts uses the shared fee step and feeBumpFor, and signs the inner tx only with the user's key", () => {
    const src = serverSource();
    const block = src.slice(src.indexOf("── Platform Fee Injection ──"), src.indexOf("// Only this call is mapped to a Horizon message"));
    expect(block).toContain("feeForSubmit(tx, expectedHash, {");
    expect(block).toContain("source: wallet.publicKey");
    expect(block).toContain("feeBumpFor(finalTx, platformSecret, passphrase)");
    expect(block.match(/finalTx\.sign\(/g)).toHaveLength(1);
    expect(block).toContain("finalTx.sign(pinKeypair!)");
    expect(src).toContain('"platform_fee_over_ceiling');
  });
});
