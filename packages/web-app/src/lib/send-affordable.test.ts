import { describe, expect, it } from "vitest";
import { affordability, spendableByAsset } from "./send-affordable";

const ISS = "GISSUER";
const account = (o: Record<string, unknown> = {}) => ({
  subentry_count: 1,
  balances: [
    { asset_type: "native", balance: "10.0000000", selling_liabilities: "0.0000000" },
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISS, balance: "100.0000000", selling_liabilities: "0.0000000" },
  ],
  ...o,
});

describe("spendableByAsset", () => {
  it("XLM keeps the reserve (0.5 x (2 + subentries + sponsoring - sponsored)) and selling liabilities; tokens keep selling liabilities", () => {
    const s = spendableByAsset(account({ num_sponsoring: 1, num_sponsored: 0 }))!;
    expect(s.get("XLM")).toBe(80_000_000n); // 10 - 0.5 * 4
    expect(s.get(`USDC:${ISS}`)).toBe(1_000_000_000n);
  });
  it("is null when the account has no balances (unknown, so nothing is blocked)", () => {
    expect(spendableByAsset({})).toBeNull();
    expect(spendableByAsset(null)).toBeNull();
  });
});

describe("affordability", () => {
  const spend = spendableByAsset(account())!; // XLM 8.5, USDC 100
  it("whole USDC balance plus the fee: blocked, and the largest amount is the balance minus the fee", () => {
    const r = affordability([{ asset: "USDC", issuer: ISS, amount: "100.1000000", upTo: false }], spend, { asset: "USDC", issuer: ISS, amount: "100" });
    expect(r).toEqual({ asset: "USDC", need: "100.1000000", have: "100.0000000", max: "99.9000000", isSendAsset: true });
  });
  it("XLM down to the reserve plus the fee: blocked, max is spendable minus the fee", () => {
    const r = affordability([{ asset: "XLM", amount: "8.5100000", upTo: false }], spend, { asset: "XLM", amount: "8.5" });
    expect(r).toMatchObject({ asset: "XLM", max: "8.4900000", isSendAsset: true });
  });
  it("enough: no block", () => {
    expect(affordability([{ asset: "XLM", amount: "8.5000000", upTo: false }], spend, { asset: "XLM", amount: "8.49" })).toBeNull();
  });
  it("the fee in XLM for a USDC send (fallback) with too little XLM: blocked on XLM, no max for the send asset", () => {
    const poor = spendableByAsset(account({ balances: [{ asset_type: "native", balance: "1.5000000" }, { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISS, balance: "100" }] }))!;
    const r = affordability([{ asset: "USDC", issuer: ISS, amount: "50.0000000", upTo: false }, { asset: "XLM", amount: "0.0100000", upTo: false }], poor, { asset: "USDC", issuer: ISS, amount: "50" });
    expect(r).toMatchObject({ asset: "XLM", need: "0.0100000", have: "0.0000000", isSendAsset: false });
  });
  it("when the user pays the network fee (not Amma), it comes off the spendable XLM", () => {
    expect(affordability([{ asset: "XLM", amount: "8.5000000", upTo: false }], spend, { asset: "XLM", amount: "8.49" }, 200n)).toMatchObject({ asset: "XLM", have: "8.4999800", max: "8.4899800" });
    expect(affordability([{ asset: "XLM", amount: "8.4000000", upTo: false }], spend, { asset: "XLM", amount: "8.39" }, 200n)).toBeNull();
  });
  it("an asset the account does not hold counts as 0", () => {
    expect(affordability([{ asset: "EURC", issuer: ISS, amount: "1.0000000", upTo: false }], spend, { asset: "EURC", issuer: ISS, amount: "1" })).toMatchObject({ have: "0.0000000", max: "0.0000000" });
  });
});
