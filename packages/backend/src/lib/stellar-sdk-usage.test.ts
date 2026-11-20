import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";

// Guard for finding 13 in docs/xrpl/SERVER_FINDINGS.md.
//
// @stellar/typescript-wallet-sdk ships as a webpack bundle that inlines its own copy of
// query-string / decode-uri-component, which carry denial-of-service advisories with no
// compatible fix. That code is only used by the SDK's anchor features (SEP-6, SEP-12 customer,
// SEP-38 and the transaction watcher). The backend accepts the risk only while it uses the SDK
// for plain Stellar account and transaction handling. These tests fail if that changes, so the
// risk is re-assessed instead of silently widening.

const SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split(sep).join("/"),
  text: readFileSync(path, "utf-8"),
}));

describe("@stellar/typescript-wallet-sdk usage (finding 13 guard)", () => {
  it("is imported only by lib/stellar-client.ts", () => {
    const importers = files
      .filter((f) => f.text.includes("@stellar/typescript-wallet-sdk"))
      .map((f) => f.path);
    expect(importers).toEqual(["lib/stellar-client.ts"]);
  });

  it("imports only Wallet and StellarConfiguration", () => {
    const client = files.find((f) => f.path === "lib/stellar-client.ts");
    expect(client).toBeDefined();
    const match = client!.text.match(
      /import\s*\{([^}]*)\}\s*from\s*["']@stellar\/typescript-wallet-sdk["']/,
    );
    expect(match).not.toBeNull();
    const names = match![1]
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    expect(names).toEqual(["StellarConfiguration", "Wallet"]);
  });

  it("only calls wallet.stellar() on the SDK Wallet object", () => {
    const used = files.flatMap((f) =>
      [...f.text.matchAll(/(?:stellarClient|this)\s*\.\s*wallet\s*\.\s*(\w+)/g)].map((m) => m[1]),
    );
    expect(used.length).toBeGreaterThan(0);
    expect([...new Set(used)]).toEqual(["stellar"]);
  });

  it("does not call the anchor, customer or watcher features", () => {
    const banned =
      /\.(anchor|sep6|sep12|sep24|sep38|customer|watcher)\s*\(|new\s+(Anchor|Watcher|Customer|Sep6|Sep12|Sep24|Sep38)\b/;
    const offenders = files.filter((f) => banned.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
