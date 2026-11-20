import { describe, it, expect, vi, beforeEach } from "vitest";
import { serverSource } from "../test-support/server-source";
import { readFileSync } from "fs";
import { join } from "path";
import * as StellarSdk from "@stellar/stellar-sdk";
import { applyPlatformFee, platformFeeStep, resetPlatformFeeCaches, userPays } from "./platform-fee";

// Deploy blockers for PR #261: the fee is shown before approval (dry-run quote) and the quoted rebuilt hash is the one submitted.

const PASS = StellarSdk.Networks.PUBLIC;
const user = StellarSdk.Keypair.random().publicKey();
const platformKp = StellarSdk.Keypair.random();
const platform = platformKp.publicKey();
const dest = StellarSdk.Keypair.random().publicKey();
const issuer = StellarSdk.Keypair.random().publicKey();
const usdc = new StellarSdk.Asset("USDC", issuer);
const XLM = StellarSdk.Asset.native();

const line = (o: Record<string, any> = {}) => ({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "0", limit: "1000000", buying_liabilities: "0", is_authorized: true, ...o });
const horizon = (lines: any[] = [line()], quote = "0.0025000") => ({
  loadAccount: vi.fn(async () => ({ balances: lines })),
  strictReceivePaths: vi.fn(() => ({ call: async () => ({ records: [{ source_amount: quote }] }) })),
});
const warn = vi.fn();
const opts = (h: any = horizon(), extra: Record<string, any> = {}) => ({
  feePercent: 0.1, minFeeXlm: 0.01, platformWallet: platform, platformSecret: platformKp.secret(), source: user, passphrase: PASS, horizon: h, warn, ...extra,
});
const build = (ops: StellarSdk.xdr.Operation[]) => {
  const b = new StellarSdk.TransactionBuilder(new StellarSdk.Account(user, "41"), { fee: "100", networkPassphrase: PASS });
  ops.forEach((o) => b.addOperation(o));
  return b.setTimeout(300).build().toXDR();
};
const parse = (xdr: string) => StellarSdk.TransactionBuilder.fromXDR(xdr, PASS) as StellarSdk.Transaction;
const pay = (amount: string, asset = XLM) => StellarSdk.Operation.payment({ destination: dest, asset, amount });
const hex = (t: any) => t.hash().toString("hex");

beforeEach(() => { resetPlatformFeeCaches(); warn.mockReset(); });

describe("platformFeeStep: the one fee step both routes use", () => {
  it("gives the same result as applyPlatformFee", async () => {
    const xdr = build([pay("10")]);
    const a = await platformFeeStep(parse(xdr), opts());
    resetPlatformFeeCaches();
    const b = await applyPlatformFee(parse(xdr), opts());
    expect(hex(a.finalTx)).toBe(hex(b.finalTx));
    expect(a.feeDetails).toEqual(b.feeDetails);
  });

  it("a failure inside the fee step submits without the fee and logs platform_fee_skipped reason error", async () => {
    const tx = parse(build([pay("10", usdc)]));
    // No network passphrase: building the rebuilt transaction throws inside the fee step.
    const r = await platformFeeStep(tx, { ...opts(horizon([])), passphrase: undefined as any });
    expect(r.finalTx).toBe(tx);
    expect(r.feeDetails).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: "error" }), "platform_fee_skipped");
  });
});

describe("quote == charge: the same envelope gives the same rebuilt hash", () => {
  it("a quote and the later sign-and-submit of the same XDR rebuild to the identical hash, even if Horizon changes in between", async () => {
    const xdr = build([pay("1", usdc)]);
    const quote = await platformFeeStep(parse(xdr), opts(horizon()));
    // Price and trustline change after the quote: the cached decision still wins.
    const charge = await platformFeeStep(parse(xdr), opts(horizon([], "0.0090000")));
    expect(hex(charge.finalTx)).toBe(hex(quote.finalTx));
    expect(charge.feeDetails).toEqual(quote.feeDetails);
    expect(quote.feeDetails.feeOperations).toEqual([{ asset: "USDC", amount: "0.0025000", xlmFallbackFor: [] }]);
  });

  it("no fee: the quoted hash is the client's own hash", async () => {
    const xdr = build([StellarSdk.Operation.changeTrust({ asset: usdc })]);
    const q = await platformFeeStep(parse(xdr), opts());
    expect(hex(q.finalTx)).toBe(hex(parse(xdr)));
    expect(q.feeDetails).toBeNull();
  });
});

describe("fee lines and what the user pays", () => {
  it("10 XLM payment: user pays 10.01 XLM", async () => {
    const { finalTx } = await platformFeeStep(parse(build([pay("10")])), opts());
    expect(userPays((finalTx as StellarSdk.Transaction).operations as any)).toEqual([{ asset: "XLM", amount: "10.0100000", upTo: false }]);
  });

  it("100 USDC with no platform trustline: 100 USDC plus 0.01 XLM, and the XLM line says it stands in for USDC", async () => {
    const { finalTx, feeDetails } = await platformFeeStep(parse(build([pay("100", usdc)])), opts(horizon([])));
    expect(feeDetails.feeOperations).toEqual([{ asset: "XLM", amount: "0.0100000", xlmFallbackFor: ["USDC"] }]);
    expect(userPays((finalTx as StellarSdk.Transaction).operations as any)).toEqual([
      { asset: "USDC", issuer, amount: "100.0000000", upTo: false },
      { asset: "XLM", amount: "0.0100000", upTo: false },
    ]);
  });

  it("a strict-receive swap is marked as 'up to' (sendMax)", () => {
    const op = StellarSdk.Operation.pathPaymentStrictReceive({ sendAsset: XLM, sendMax: "12", destination: user, destAsset: usdc, destAmount: "1" });
    expect(userPays(parse(build([op])).operations as any)).toEqual([{ asset: "XLM", amount: "12.0000000", upTo: true }]);
  });
});

describe("routes (source)", () => {
  const src = serverSource();
  const quoteBlock = readFileSync(join(__dirname, "..", "routes", "fee-quote.ts"), "utf-8");
  const signStart = src.indexOf('"/api/v1/transactions/sign-and-submit"');
  const signBlock = src.slice(signStart, src.indexOf('"/api/v1/user/signing-mode"'));

  it("fee-quote: registered, authenticated, rate limited, read only (no signing, no password, no writes)", () => {
    expect(src).toContain("app.register(feeQuoteRoutes);");
    expect(quoteBlock).toContain("preHandler: authMiddleware");
    expect(quoteBlock).toMatch(/rateLimit: \{ max: \d+, timeWindow: "15 minutes" \}/);
    expect(quoteBlock).toContain("platformFeeStep(tx, {");
    expect(quoteBlock).toContain("foreignSourceOp(");
    for (const banned of [".sign(", "signWithCustody", "checkCustodyPassword", "decryptSecret", "submitStellarTx", ".insert(", ".update(", "auditLog(", "feeBumpFor("]) {
      expect(quoteBlock).not.toContain(banned);
    }
  });

  it("sign-and-submit: one fee step, refuses a changed fee before any signing, and always returns the inner hash", () => {
    expect(signBlock).toContain("feeForSubmit(tx, expectedHash, {");
    const refuse = signBlock.indexOf("if (charged.refused) return reply.status(charged.refused.status)");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(signBlock.indexOf("signWithCustody("));
    expect(refuse).toBeLessThan(signBlock.indexOf("finalTx.sign(pinKeypair!)"));
    expect(signBlock).toMatch(/innerHash: finalTx\.hash\(\)\.toString\("hex"\)/);
    // the schema lists innerHash on 200, 202 and 500
    expect(signBlock.match(/innerHash: \{ type: "string" \}/g)!.length).toBeGreaterThanOrEqual(3);
    // the 500 after an unknown failure carries the inner hash once it is known
    expect(signBlock).toMatch(/status\(500\)\.send\(\{\s*error: "Failed to sign and submit",\s*\.\.\.\(innerHash \? \{ innerHash \} : \{\}\)/);
  });
});
