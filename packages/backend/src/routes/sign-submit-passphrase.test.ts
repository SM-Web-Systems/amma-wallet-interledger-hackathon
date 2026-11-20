import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { serverSource, serverSourceWith } from "../test-support/server-source";

// server.ts with the sign-and-submit handler (routes/sign-and-submit.ts) put back in place, so the moved code is guarded too.
const serverSrc = serverSource();

describe("sign-and-submit networkPassphrase (P0-3-F6)", () => {
  it("does not use client-supplied networkPassphrase as fallback", () => {
    // After fix, server should NOT have "clientPassphrase ||" pattern
    expect(serverSrc).not.toContain("clientPassphrase ||");
  });

  it("would catch the pattern if it came back in the moved handler", () => {
    expect(serverSrc).toContain("feeForSubmit(tx, expectedHash, {");
    expect(serverSourceWith("const passphrase = clientPassphrase || stellarClient.networkPassphrase;")).toContain("clientPassphrase ||");
  });

  it("always uses server-configured networkPassphrase", () => {
    // The passphrase variable should be assigned directly from stellarClient
    expect(serverSrc).toContain("stellarClient.networkPassphrase;");
  });
});
