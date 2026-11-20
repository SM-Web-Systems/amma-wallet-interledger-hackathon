import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { serverSource, serverSourceWith } from "../test-support/server-source";

describe("server.ts — PII logging guards (P0-3-F14)", () => {
  // server.ts with the sign-and-submit handler (routes/sign-and-submit.ts) put back in place, so the moved code is guarded too.
  const src = serverSource();

  it("covers the moved sign-and-submit handler", () => {
    expect(src).toContain("feeForSubmit(tx, expectedHash, {");
    // The same line filter as below finds a console.log reintroduced in the moved handler.
    const injected = serverSourceWith('console.log("sign-and-submit", userId);').split("\n");
    expect(injected.some((l) => l.includes("console.log") && l.includes("userId") && l.includes("sign-and-submit"))).toBe(true);
  });

  it("should not have unguarded console.log with userId in sign-and-submit handlers", () => {
    const lines = src.split("\n");
    const userIdLogs = lines.filter(
      (l) => l.includes("console.log") && l.includes("userId") && l.includes("sign-and-submit") && !l.trim().startsWith("//")
    );
    expect(userIdLogs.length).toBe(0);
  });

  it("should not have unguarded console.log with publicKey in sign-and-submit handlers", () => {
    const lines = src.split("\n");
    const pkLogs = lines.filter(
      (l) => l.includes("console.log") && l.includes("publicKey") && !l.trim().startsWith("//")
    );
    expect(pkLogs.length).toBe(0);
  });
});
