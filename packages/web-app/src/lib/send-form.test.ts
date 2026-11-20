import { describe, expect, it } from "vitest";
import { isWrongPassphrase, validateSend } from "./send-form";

const t = (_key: string, fallback?: string) => fallback ?? _key;
const valid = () => true;
const invalid = () => false;

describe("validateSend", () => {
  it("says what is missing, field by field", () => {
    expect(validateSend({ destination: "", amount: "" }, valid, t)).toEqual({
      destination: "Enter the address you are sending to.",
      amount: "Enter an amount.",
    });
  });
  it("flags an address that is not a Stellar address, next to the address", () => {
    expect(validateSend({ destination: "nope", amount: "5" }, invalid, t)).toEqual({ destination: "Invalid Stellar address" });
  });
  it("flags zero, negative and non-numeric amounts, next to the amount", () => {
    for (const amount of ["0", "-1", "abc"]) {
      expect(validateSend({ destination: "G", amount }, valid, t).amount).toBe("Enter an amount greater than zero.");
    }
  });
  it("passes a good form", () => {
    expect(validateSend({ destination: "G", amount: "0.5" }, valid, t)).toEqual({});
  });
});

describe("isWrongPassphrase", () => {
  it("recognises the server's wrong-passphrase answer, and the older wording during rollout", () => {
    expect(isWrongPassphrase(new Error("Incorrect wallet passphrase. The wallet could not be unlocked."))).toBe(true);
    expect(isWrongPassphrase(new Error("Invalid PIN. The wallet could not be unlocked."))).toBe(true);
    expect(isWrongPassphrase(new Error("The current wallet passphrase is not correct."))).toBe(true);
  });
  it("does not treat other failures as a wrong passphrase", () => {
    expect(isWrongPassphrase(new Error("Network request failed"))).toBe(false);
    expect(isWrongPassphrase(new Error("op_underfunded"))).toBe(false);
    expect(isWrongPassphrase(undefined)).toBe(false);
  });
});
