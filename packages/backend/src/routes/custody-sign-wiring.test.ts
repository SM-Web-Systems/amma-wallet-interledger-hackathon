import { describe, it, expect } from "vitest";
import { serverSource } from "../test-support/server-source";
import { readFileSync } from "fs";
import { join } from "path";

const src = serverSource();
const a = src.indexOf('"/api/v1/transactions/sign"');
const b = src.indexOf('"/api/v1/transactions/sign-and-submit"');
const c = src.indexOf('"/api/v1/user/signing-mode"');
const routes: Record<string, string> = { sign: src.slice(a, b), "sign-and-submit": src.slice(b, c) };

describe.each(Object.entries(routes))("%s custody wiring", (_name, block) => {
  it("pin always wins over the password path", () => {
    expect(block).toMatch(/const custodyPath = !pin &&/);
  });
  it("every encrypted_secret check allows the custody path", () => {
    const checks = block.split("\n").filter((l) => /if \(.*encryptedSecret/.test(l));
    expect(checks.length).toBeGreaterThan(0);
    for (const l of checks) expect(l).toContain("&& !custodyPath");
  });
  it("custody branch comes after the transaction source check", () => {
    const srcCheck = block.indexOf("txSource !== wallet.publicKey");
    const custody = block.indexOf("if (custodyPath) {");
    expect(srcCheck).toBeGreaterThan(-1);
    expect(custody).toBeGreaterThan(srcCheck);
  });
});

describe("sign-and-submit checks the password before the fee step", () => {
  it("calls checkCustodyPassword before the fee step and before signing", () => {
    const block = routes["sign-and-submit"];
    const check = block.indexOf("checkCustodyPassword(");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(block.indexOf("Platform Fee Injection"));
    expect(check).toBeLessThan(block.indexOf("signWithCustody("));
    expect(block).toContain("signWithCustody(");
  });
});

describe("operations with another account as source are refused before any signing", () => {
  it.each(Object.entries(routes))("%s refuses a foreign-source operation right after the transaction source check", (_n, block) => {
    const srcCheck = block.indexOf("txSource !== wallet.publicKey");
    const foreign = block.indexOf("foreignSourceOp(");
    expect(foreign).toBeGreaterThan(srcCheck);
    expect(foreign).toBeLessThan(block.indexOf("if (custodyPath) {"));
    expect(block).toContain("FOREIGN_SOURCE_ERROR");
  });
});
