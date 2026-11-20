import { beforeEach, describe, expect, it } from "vitest";
import { dropSendKey, isSettled, keepSendKey, sendSlot, storedSendKey } from "./custody-pending";

const K = "0b6b7a3e-1d2f-4a5b-8c9d-0e1f2a3b4c5d";
const eth = { chain: "evm" as const, from: "0xAAAA000000000000000000000000000000000000", to: "0x1111111111111111111111111111111111111111", amountBase: "10000000000000000" };
const xrp = { chain: "xrpl" as const, from: "rMAIN0000000000000000000000000000", to: "rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn", amountBase: "1500000", tag: 42 };
beforeEach(() => sessionStorage.clear());

describe("custody send keys", () => {
  it("keeps, reads and drops a key per chain, wallet, destination, amount and tag", () => {
    keepSendKey(eth, K);
    expect(storedSendKey(eth)).toBe(K);
    expect(storedSendKey({ ...eth, from: eth.from.toLowerCase() })).toBe(K);
    expect(storedSendKey({ ...eth, amountBase: "1" })).toBeUndefined();
    keepSendKey(xrp, K);
    expect(storedSendKey({ ...xrp, tag: undefined })).toBeUndefined();
    expect(sendSlot(xrp)).toBe("amma.custodySendKey.xrpl.rMAIN0000000000000000000000000000.rf1BiGeXwwQoi8Z2ueFYTEXSwuJYfV2Jpn.1500000.42");
    dropSendKey(eth);
    expect(storedSendKey(eth)).toBeUndefined();
    expect(storedSendKey(xrp)).toBe(K);
  });
  it("ignores a stored value that is not a UUID", () => {
    sessionStorage.setItem(sendSlot(eth), "not-a-key");
    expect(storedSendKey(eth)).toBeUndefined();
  });
  it("calls a result settled only when it is not unknown and its state is final for this purpose", () => {
    for (const state of ["broadcast", "confirmed", "failed", "submitted", "validated_success", "validated_failure", "expired", "cancelled"]) expect(isSettled({ state })).toBe(true);
    for (const state of ["signed", "prepared", "awaiting_approval"]) expect(isSettled({ state })).toBe(false);
    expect(isSettled({ state: "broadcast", status: "unknown" })).toBe(false);
    expect(isSettled({})).toBe(false);
  });
});
