import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// G-06: login codes and verification tokens must reach the database only as keyed hashes.
const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8").replace(/\r\n/g, "\n");

describe("email codes are stored hashed (G-06)", () => {
  for (const file of ["auth.ts", "two-fa.ts"]) {
    const src = read(file);

    it(`${file}: every email_codes insert stores hashEmailCode(code)`, () => {
      const blocks = src.split("insert(schema.emailCodes).values({").slice(1).map((b) => b.slice(0, b.indexOf("});")));
      for (const block of blocks) expect(block).toMatch(/code:\s*hashEmailCode\(code\)/);
    });

    it(`${file}: every email_codes lookup compares a hash`, () => {
      const lookups = src.match(/eq\(schema\.emailCodes\.code,[^\n]*/g) ?? [];
      for (const l of lookups) expect(l).toContain("hashEmailCode(");
    });
  }

  it("there are inserts and lookups to check", () => {
    const all = read("auth.ts") + read("two-fa.ts");
    expect((all.match(/insert\(schema\.emailCodes\)/g) ?? []).length).toBe(4);
    expect((all.match(/eq\(schema\.emailCodes\.code,/g) ?? []).length).toBe(3);
  });
});

describe("verification tokens are stored hashed (G-06)", () => {
  it("every INSERT into email_verification_tokens writes hashVerificationToken(...)", () => {
    for (const file of ["auth.ts", "account-email.ts"]) {
      const inserts = read(file).match(/INSERT INTO email_verification_tokens[^`]*/g) ?? [];
      expect(inserts.length).toBeGreaterThan(0);
      for (const i of inserts) expect(i).toContain("hashVerificationToken(");
    }
  });

  it("every lookup by token in email-claims compares a hash", () => {
    const lookups = read("../lib/email-claims.ts").match(/token = \$\{[^}]*\}/g) ?? [];
    expect(lookups.length).toBe(3);
    for (const l of lookups) expect(l).toContain("hashVerificationToken(");
  });
});
