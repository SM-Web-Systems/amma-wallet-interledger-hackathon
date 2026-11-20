import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { balanceView, firstThatWorks } from "./balance-view";

const funded = [{ balance: "10" }];

const HOOK = "../hooks/useBalances.ts";

describe("balanceView", () => {
  it("is loading while the first load is running", () => {
    expect(balanceView({ isLoading: true, isError: false, data: undefined })).toEqual({ state: "loading", stale: false });
  });
  it("is an error, never an empty wallet, when the load failed and nothing was loaded before", () => {
    expect(balanceView({ isLoading: false, isError: true, data: undefined })).toEqual({ state: "error", stale: false });
    expect(balanceView({ isLoading: false, isError: true, data: [] })).toEqual({ state: "error", stale: false });
  });
  it("keeps showing the last known balances, marked stale, when a refresh fails", () => {
    expect(balanceView({ isLoading: false, isError: true, data: funded })).toEqual({ state: "ready", stale: true });
  });
  it("is unfunded only when the load worked and the account has nothing", () => {
    expect(balanceView({ isLoading: false, isError: false, data: [] })).toEqual({ state: "unfunded", stale: false });
  });
  it("is ready with balances", () => {
    expect(balanceView({ isLoading: false, isError: false, data: funded })).toEqual({ state: "ready", stale: false });
  });
});

describe("extension Dashboard uses it", () => {
  const src = readFileSync(join(__dirname, "../../popup/pages/Dashboard.tsx"), "utf8");
  it("reads the load error and offers Retry", () => {
    expect(src).toContain("isError");
    expect(src).toContain("balanceView(");
    expect(src).toMatch(/refetch\(\)/);
  });
  it("does not print a zero balance when the load failed", () => {
    expect(src).toMatch(/view\.state === "error"[^\n]*"—"/);
  });
});

describe("firstThatWorks", () => {
  it("uses the first source when it answers", async () => {
    expect(await firstThatWorks(async () => ["a"], async () => ["b"])).toEqual(["a"]);
  });
  it("asks the second source when the first fails, so an unfunded account reads as empty, not as an error", async () => {
    expect(await firstThatWorks(async () => { throw new Error("500"); }, async () => [])).toEqual([]);
  });
  it("fails when both fail", async () => {
    await expect(firstThatWorks(async () => { throw new Error("a"); }, async () => { throw new Error("b"); })).rejects.toThrow("b");
  });
});

describe("testnet hooks fall back to Horizon", () => {
  it("reads Horizon when the backend balance route fails", () => {
    const hook = readFileSync(join(__dirname, HOOK), "utf8");
    expect(hook).toMatch(/firstThatWorks\(/);
    expect(hook).toMatch(/tokenApi\.userTokens\(publicKey\)/);
    expect(hook).toMatch(/fetchBalancesFromHorizon\(publicKey, network\)/);
  });
});
