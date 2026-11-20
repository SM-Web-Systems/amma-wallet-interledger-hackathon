import { describe, expect, it } from "vitest";
import { chainStorageRunnerAllowed } from "./chain-storage-runner";

describe("chain storage runner network guard", () => {
  it("runs on testnet", () => { expect(chainStorageRunnerAllowed({ STELLAR_NETWORK: "testnet" })).toBe(true); });
  it("runs on mainnet only with MAINNET_CUSTODY=on", () => {
    expect(chainStorageRunnerAllowed({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" })).toBe(true);
    expect(chainStorageRunnerAllowed({ STELLAR_NETWORK: "public" })).toBe(false);
    expect(chainStorageRunnerAllowed({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "true" })).toBe(false);
  });
  it("refuses an unset or unknown network", () => {
    expect(chainStorageRunnerAllowed({})).toBe(false);
    expect(chainStorageRunnerAllowed({ STELLAR_NETWORK: "futurenet", MAINNET_CUSTODY: "on" })).toBe(false);
  });
});
