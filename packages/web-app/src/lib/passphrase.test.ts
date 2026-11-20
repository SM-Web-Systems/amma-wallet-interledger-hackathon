import { describe, it, expect } from "vitest";
import { passphraseProblem, isLegacyPin, changePassphraseProblem, PASSPHRASE_MIN } from "./passphrase";

describe("Stellar wallet passphrase rule (audit F-1/F-2)", () => {
  it("needs at least 12 characters, like the XRP and Ethereum vaults", () => {
    expect(PASSPHRASE_MIN).toBe(12);
    expect(passphraseProblem("short pass")).toMatch(/12 characters/);
    expect(passphraseProblem("river lamp ok")).toBeNull();
  });
  it("refuses digits only, however long", () => {
    expect(passphraseProblem("123456789012")).toMatch(/not only numbers/);
  });
  it("refuses blank or whitespace-only input", () => {
    expect(passphraseProblem("              ")).toMatch(/12 characters/);
  });
  it("refuses more than 128 characters", () => {
    expect(passphraseProblem("a".repeat(129))).toMatch(/128/);
  });
  it("treats anything failing the rule as a legacy PIN to upgrade", () => {
    expect(isLegacyPin("123456")).toBe(true);
    expect(isLegacyPin("abcdef")).toBe(true);
    expect(isLegacyPin("correct horse battery")).toBe(false);
  });
});

describe("change-passphrase form rule", () => {
  const CURRENT = "correct horse battery";
  const NEXT = "a different long passphrase";
  it("accepts a current passphrase, a strong new one and a matching repeat", () => {
    expect(changePassphraseProblem(CURRENT, NEXT, NEXT)).toBeNull();
  });
  it("asks for the current passphrase", () => {
    expect(changePassphraseProblem("", NEXT, NEXT)).toMatch(/current passphrase/i);
  });
  it("applies the setup rule to the new passphrase", () => {
    expect(changePassphraseProblem(CURRENT, "short", "short")).toMatch(/12 characters/);
    expect(changePassphraseProblem(CURRENT, "123456789012", "123456789012")).toMatch(/not only numbers/);
  });
  it("rejects an unchanged passphrase and a repeat that does not match", () => {
    expect(changePassphraseProblem(NEXT, NEXT, NEXT)).toMatch(/different/i);
    expect(changePassphraseProblem(CURRENT, NEXT, NEXT + "x")).toMatch(/do not match/i);
  });
});
