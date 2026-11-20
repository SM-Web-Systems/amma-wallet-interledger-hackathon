import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { availableNetworks, effectiveNetwork, networkBadgeText, resolveLock } from "../network-lock";

const root = new URL("../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

describe("phone network lock (G-09)", () => {
  it("a testnet lock offers only testnet; no lock offers both", () => {
    expect(availableNetworks("testnet")).toEqual(["testnet"]);
    expect(availableNetworks("none")).toEqual(["testnet", "public"]);
  });
  it("only the value testnet turns the lock on, so preview and production builds are not locked", () => {
    expect(resolveLock("testnet")).toBe("testnet");
    expect(resolveLock(undefined)).toBe("none");
    expect(resolveLock("")).toBe("none");
  });
  it("mainnet becomes testnet under the lock, including a value saved earlier", () => {
    expect(effectiveNetwork("public", "testnet")).toBe("testnet");
    expect(effectiveNetwork("public", "none")).toBe("public");
  });
  it("the badge says test money in plain words, and only under the lock", () => {
    expect(networkBadgeText("testnet")).toBe("Test network, no real money");
    expect(networkBadgeText("none")).toBeNull();
  });
});

describe("the phone uses the lock (G-09)", () => {
  it("the testnet EAS profile sets the lock, and preview and production do not", () => {
    const eas = JSON.parse(read("eas.json")) as { build: Record<string, { env?: Record<string, string> }> };
    expect(eas.build.testnet.env?.EXPO_PUBLIC_NETWORK_LOCK).toBe("testnet");
    expect(eas.build.preview.env?.EXPO_PUBLIC_NETWORK_LOCK).toBeUndefined();
    expect(eas.build.production.env?.EXPO_PUBLIC_NETWORK_LOCK).toBeUndefined();
  });
  it("the root layout shows the badge on every screen", () => {
    expect(read("app/_layout.tsx")).toContain("<NetworkBadge");
  });
  it("Settings (the screen that is actually shown) hides the Mainnet button under the lock", () => {
    const settings = read("app/settings.tsx");
    expect(settings).toContain('availableNetworks(NETWORK_LOCK).includes("public")');
    // The Mainnet button is inside that condition, not outside it.
    const guard = settings.indexOf('availableNetworks(NETWORK_LOCK).includes("public")');
    expect(settings.indexOf("Mainnet", guard)).toBeGreaterThan(guard);
    expect(settings.indexOf("Mainnet")).toBeGreaterThan(guard - 1);
  });
  it("the badge sits below the status bar using the safe-area inset, not a fixed padding", () => {
    const badge = read("src/components/NetworkBadge.tsx");
    expect(badge).toContain("useSafeAreaInsets");
    expect(badge).toContain("paddingTop: insets.top");
  });
  it("the switcher lists only available networks and the store refuses a locked one", () => {
    expect(read("src/components/NetworkSwitcher.tsx")).toContain("availableNetworks(NETWORK_LOCK)");
    expect(read("src/shared/store/wallet.ts")).toContain("effectiveNetwork(n, NETWORK_LOCK)");
  });
});
