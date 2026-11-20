import { describe, it, expect } from "vitest";
import { serverSource } from "../test-support/server-source";
import { readFileSync } from "fs";
import { join } from "path";

// G-07 / D-23 / D-41: no route takes a secret key from a client, and the signing routes never
// echo the internal decrypt message.
const read = (...parts: string[]) => readFileSync(join(__dirname, ...parts), "utf-8");
import { WRONG_PIN_MESSAGE } from "../lib/signing-errors";
const serverSrc = serverSource();

describe("G-07: the endpoint that takes a secret key in the body is gone", () => {
  it("has no /api/v1/keypair/from-secret route or documentation line", () => {
    expect(serverSrc).not.toContain("keypair/from-secret");
    expect(serverSrc).not.toContain("Keypair from-secret");
  });

  it.each([
    ["web", "../../../web-app/src/lib/api.ts"],
    ["extension", "../../../chrome-extension/src/shared/lib/api.ts"],
    ["mobile", "../../../mobile/src/shared/lib/api.ts"],
  ])("the %s client no longer has a from-secret wrapper", (_name, path) => {
    const src = read(path);
    expect(src).not.toContain("keypair/from-secret");
    expect(src).not.toMatch(/fromSecret\s*:/);
  });
});

describe("D-41: signing routes do not echo internal decrypt errors", () => {
  it("has one fixed, non-technical message for a failed unlock", () => {
    expect(WRONG_PIN_MESSAGE).toBe("Incorrect wallet passphrase. The wallet could not be unlocked.");
    expect(WRONG_PIN_MESSAGE).not.toMatch(/decrypt|ciphertext|auth tag|corrupt/i);
  });

  it("both signing routes answer a failed unlock with that constant", () => {
    expect(serverSrc.match(/error:\s*WRONG_PIN_MESSAGE/g)?.length).toBe(2);
  });

  it("never lets the decrypt error reach a response (it may only be logged)", () => {
    const hits = [...serverSrc.matchAll(/decryptErr\./g)];
    for (const hit of hits) {
      const before = serverSrc.slice(Math.max(0, hit.index! - 120), hit.index!);
      expect(before).toContain("console.error");
    }
    expect(serverSrc).not.toMatch(/Incorrect wallet passphrase[^"\n]*decrypt wallet/);
  });

  it("the outer catches of both signing routes return a fixed message in every environment", () => {
    const start = serverSrc.indexOf('"/api/v1/transactions/sign"');
    const end = serverSrc.indexOf('"/api/v1/transactions/sign-and-submit"');
    const signRoute = serverSrc.slice(start, end);
    const nextRoute = serverSrc.slice(end + 1).search(/\bapp\.(get|post|put|patch|delete)\(/);
    expect(nextRoute).toBeGreaterThan(0);
    const submitRoute = serverSrc.slice(end, end + 1 + nextRoute);
    expect(signRoute).toContain('error: "Failed to sign transaction"');
    expect(submitRoute).toContain('error: "Failed to sign and submit"');
    for (const route of [signRoute, submitRoute]) {
      expect(route).not.toMatch(/error\.message \|\| "Failed to sign/);
    }
  });
});
