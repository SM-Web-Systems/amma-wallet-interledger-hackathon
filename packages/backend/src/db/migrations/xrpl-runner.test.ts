import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { xrplMainnetRunnerAllowed, xrplRunnerAllowed } from "./xrpl-runner";

const ON = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet", XRPL_MAINNET_CUSTODY: "on" };

describe("XRP payment runner network guard", () => {
  it("runs on isolated testnet as before", () => {
    expect(xrplRunnerAllowed({ STELLAR_NETWORK: "testnet" })).toBe(true);
    expect(xrplRunnerAllowed({ STELLAR_NETWORK: "testnet", XRPL_NETWORK: "testnet" })).toBe(true);
    expect(xrplRunnerAllowed({ STELLAR_NETWORK: "testnet", XRPL_NETWORK: "mainnet" })).toBe(false);
  });
  it("runs on mainnet only with XRPL_MAINNET_CUSTODY=on and the mainnet custody mode", () => {
    expect(xrplRunnerAllowed(ON)).toBe(true);
    expect(xrplRunnerAllowed({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" })).toBe(false);
    expect(xrplRunnerAllowed({ ...ON, XRPL_MAINNET_CUSTODY: "off" })).toBe(false);
    expect(xrplRunnerAllowed({ ...ON, MAINNET_CUSTODY: "true" })).toBe(false);
    expect(xrplRunnerAllowed({ ...ON, XRPL_NETWORK: "testnet" })).toBe(false);
    expect(xrplRunnerAllowed({})).toBe(false);
  });
  it("the mainnet widening runs only with the switch on", () => {
    expect(xrplMainnetRunnerAllowed(ON)).toBe(true);
    expect(xrplMainnetRunnerAllowed({ STELLAR_NETWORK: "testnet" })).toBe(false);
    expect(xrplMainnetRunnerAllowed({ ...ON, XRPL_MAINNET_CUSTODY: undefined })).toBe(false);
  });
  it("every XRP runner uses the guard", () => {
    for (const f of ["migrate-xrpl-payments.ts", "migrate-xrpl-reconciliation.ts", "migrate-xrpl-integration.ts"]) expect(readFileSync(join(__dirname, f), "utf8"), f).toMatch(/if ?\(!xrplRunnerAllowed\(process\.env\)\) ?throw/);
    expect(readFileSync(join(__dirname, "migrate-xrpl-mainnet.ts"), "utf8")).toMatch(/if \(!xrplMainnetRunnerAllowed\(process\.env\)\) throw/);
  });
});
