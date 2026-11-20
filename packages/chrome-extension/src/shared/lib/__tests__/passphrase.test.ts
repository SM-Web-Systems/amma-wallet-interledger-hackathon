// TODO D2 (audit F-2): new extension wallets need the same 12+ character
// passphrase rule as web, XRP and Ethereum; `000000` is no longer accepted.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { passphraseProblem, PASSPHRASE_MIN } from "../passphrase";

describe("extension passphrase rule", () => {
  it.each(["000000", "123456", "short", "123456789012345", "   twelve   "])("rejects %j", (p) => {
    expect(passphraseProblem(p)).not.toBeNull();
  });

  it.each(["lamp river garden 42", "correct horse battery"])("accepts %j", (p) => {
    expect(passphraseProblem(p)).toBeNull();
  });

  it("matches the web rule (12 characters)", () => {
    expect(PASSPHRASE_MIN).toBe(12);
  });

  it("every create/import path in onboarding uses it", () => {
    const src = readFileSync(resolve(__dirname, "../../../popup/pages/Onboarding.tsx"), "utf8");
    expect(src).not.toMatch(/pin\.length < 6/);
    expect(src.match(/passphraseProblem\(pin\)/g)?.length).toBe(4);
  });
});
