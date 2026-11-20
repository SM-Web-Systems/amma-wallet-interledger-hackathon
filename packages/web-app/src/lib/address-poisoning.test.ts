import { describe, expect, it } from "vitest";
import { suspiciousOperationKeys, looksAlike, DUST_MAX_XLM } from "./address-poisoning";

// Real pattern seen on mainnet on 2026-11-17: 10 s after each real transfer, a bot sent 0.0001 XLM from an address
// with the same first and last characters as a real one, so a copy from History picks the fake.
const ME = "GBRF2YNVJT45XYGN5FFUUPG35YRUIMHFMC5LCVUHNDHJAHVUJTKVIAXT";
const LEARNER = "GCK6WIPKLYBWWIF4D736P6BEEM6UPMYKKK26KDJBAZVDGL7XYC37BFY3";
const FAKE_LEARNER = "GCK6" + "M".repeat(48) + "BFY3"; // same first 4 and last 4 as LEARNER
const FAKE_ME = "GBRF" + "Q".repeat(48) + "IAXT"; // same first 4 and last 4 as ME
const STRANGER = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";

const pay = (id: string, from: string, to: string, amount: string, asset_type = "native") => ({ id, type: "payment", from, to, amount, asset_type });
const create = (id: string, funder: string, account: string, starting_balance: string) => ({ id, type: "create_account", funder, account, starting_balance });

describe("look-alike addresses", () => {
  it("match when the first 4 and last 4 characters agree but the address differs", () => {
    expect(looksAlike(LEARNER, FAKE_LEARNER)).toBe(true);
    expect(looksAlike(LEARNER, LEARNER)).toBe(false);
    expect(looksAlike(LEARNER, STRANGER)).toBe(false);
  });
});

describe("suspicious dust in History", () => {
  it("flags a tiny incoming payment from a look-alike of someone I really dealt with", () => {
    const ops = [create("1", ME, LEARNER, "1.1000000"), pay("2", FAKE_LEARNER, ME, "0.0001000")];
    expect([...suspiciousOperationKeys(ops, ME)]).toEqual(["2"]);
  });

  it("flags a tiny incoming payment from a look-alike of my own address", () => {
    expect([...suspiciousOperationKeys([pay("3", FAKE_ME, ME, "0.0001000")], ME)]).toEqual(["3"]);
  });

  it("does not flag real payments, payments I sent, other assets, or tiny payments from unrelated addresses", () => {
    const ops = [
      create("1", ME, LEARNER, "1.1000000"),
      pay("2", LEARNER, ME, "0.0001000"),            // the real counterparty itself
      pay("3", FAKE_LEARNER, ME, "5.0000000"),        // not dust
      pay("4", ME, FAKE_LEARNER, "0.0001000"),        // sent by me
      pay("5", FAKE_LEARNER, ME, "0.0001000", "credit_alphanum4"), // not native
      pay("6", STRANGER, ME, "0.0001000"),            // tiny but not a look-alike
    ];
    expect(suspiciousOperationKeys(ops, ME).size).toBe(0);
  });

  it("uses a 0.01 XLM ceiling for dust", () => {
    expect(DUST_MAX_XLM).toBe(0.01);
    const OTHER_FAKE = "GCK6" + "N".repeat(48) + "BFY3";
    const ops = [create("1", ME, LEARNER, "1.1"), pay("2", FAKE_LEARNER, ME, "0.0100000"), pay("3", OTHER_FAKE, ME, "0.0100001")];
    expect([...suspiciousOperationKeys(ops, ME)]).toEqual(["2"]); // 0.0100001 is above the ceiling, so not dust
  });
});
