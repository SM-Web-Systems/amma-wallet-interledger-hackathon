import { describe, expect, it } from "vitest";
import { changePassphraseProblem } from "../passphrase";

const CURRENT = "correct horse battery";
const NEXT = "a different long passphrase";

describe("changePassphraseProblem", () => {
  it("accepts a current passphrase, a strong new one and a matching repeat", () => {
    expect(changePassphraseProblem(CURRENT, NEXT, NEXT)).toBeNull();
  });
  it("asks for the current passphrase", () => {
    expect(changePassphraseProblem("", NEXT, NEXT)).toMatch(/current passphrase/i);
  });
  it("applies the setup rules to the new passphrase", () => {
    expect(changePassphraseProblem(CURRENT, "short", "short")).toMatch(/at least 12/);
    expect(changePassphraseProblem(CURRENT, "123456789012", "123456789012")).toMatch(/not only numbers/);
    expect(changePassphraseProblem(CURRENT, "x".repeat(129), "x".repeat(129))).toMatch(/at most 128/);
  });
  it("rejects a new passphrase equal to the current one", () => {
    expect(changePassphraseProblem(CURRENT, CURRENT + " ", CURRENT + " ")).toBeNull();
    expect(changePassphraseProblem(NEXT, NEXT, NEXT)).toMatch(/different/i);
  });
  it("rejects a repeat that does not match", () => {
    expect(changePassphraseProblem(CURRENT, NEXT, NEXT + "x")).toMatch(/do not match/i);
  });
});
