import { describe, it, expect } from "vitest";
import { networkLabel } from "./network-label";
import settingsSource from "../pages/Settings.tsx?raw";

describe("networkLabel", () => {
  it("calls the public network Mainnet", () => {
    expect(networkLabel("public")).toBe("Mainnet");
  });

  it("calls the test network Testnet, so a testnet site never claims to be on Mainnet", () => {
    expect(networkLabel("testnet")).toBe("Testnet");
  });

  it("falls back to Mainnet for an unknown value", () => {
    expect(networkLabel(undefined)).toBe("Mainnet");
  });
});

describe("Settings network row", () => {
  it("shows the configured network instead of a hard-coded Mainnet", () => {
    expect(settingsSource).toContain("networkLabel(");
    expect(settingsSource).not.toMatch(/font-medium">Mainnet</);
  });
});
