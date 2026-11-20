import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { availableNetworks, effectiveNetwork, networkBadgeText, resolveLock, tokenNetworkParam } from "./network-lock";
import { requireApiUrl } from "./build-env";

const read = (p: string) => readFileSync(resolve(__dirname, "..", "..", "..", p), "utf-8").replace(/\r\n/g, "\n");

describe("network lock (G-09)", () => {
  it("a testnet lock offers only testnet", () => {
    expect(availableNetworks("testnet")).toEqual(["testnet"]);
    expect(availableNetworks("none")).toEqual(["testnet", "public"]);
  });
  it("the lock is on unless it is explicitly turned off", () => {
    expect(resolveLock(undefined)).toBe("testnet");
    expect(resolveLock("")).toBe("testnet");
    expect(resolveLock("false")).toBe("testnet");
    expect(resolveLock("none")).toBe("none");
  });
  it("mainnet becomes testnet under the lock, including a value stored by an older build", () => {
    expect(effectiveNetwork("public", "testnet")).toBe("testnet");
    expect(effectiveNetwork(undefined, "testnet")).toBe("testnet");
    expect(effectiveNetwork("public", "none")).toBe("public");
  });
  it("the badge says test money in plain words, and only under the lock", () => {
    expect(networkBadgeText("testnet")).toBe("Test network, no real money");
    expect(networkBadgeText("none")).toBeNull();
  });
});

describe("build needs an API address (G-09)", () => {
  it("refuses to build without VITE_API_URL", () => {
    expect(() => requireApiUrl(undefined)).toThrow(/VITE_API_URL/);
    expect(() => requireApiUrl("  ")).toThrow(/VITE_API_URL/);
  });
  it("uses the value it is given", () => {
    expect(requireApiUrl("https://api.example.test")).toBe("https://api.example.test");
  });
  it("the build config calls it", () => {
    expect(read("vite.config.ts")).toContain("requireApiUrl(");
  });
  it("no source file hard-codes the production host or the pubnet token network", () => {
    const walk = (dir: string): string[] => readdirSync(resolve(__dirname, "..", "..", "..", dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [`${dir}/${e.name}`] : []);
    for (const file of walk("src")) {
      const text = read(file);
      expect(text, file).not.toMatch(/["'`]https:\/\/ammawallet\.com/);
    }
    expect(read("src/shared/lib/api.ts")).not.toContain('network = "pubnet"');
  });
  it("a locked build asks the token directory about testnet only", () => {
    expect(tokenNetworkParam("testnet")).toBe("testnet");
    expect(tokenNetworkParam("none")).toBe("pubnet");
  });
});

describe("screens use the lock (G-09)", () => {
  it("the popup shows the badge on every screen and the switcher lists only available networks", () => {
    expect(read("src/popup/App.tsx")).toContain("<NetworkBadge");
    expect(read("src/shared/components/NetworkSwitcher.tsx")).toContain("availableNetworks(NETWORK_LOCK)");
  });
  it("the wallet store refuses a network the lock does not allow", async () => {
    vi.resetModules();
    localStorage.clear();
    const { useWalletStore } = await import("../store/wallet");
    useWalletStore.getState().setNetwork("public");
    expect(useWalletStore.getState().network).toBe("testnet");
  }, 30_000); // cold import of the whole wallet store (Stellar SDK) can pass 5s on a loaded self-hosted runner
});

describe("a Mainnet value saved by an older build (G-09)", () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); });

  it("becomes testnet when the store loads, not only when someone switches", async () => {
    const { mergePersistedWallet } = await import("../store/wallet");
    const current = { network: "testnet" as "testnet" | "public", accounts: [] as string[] };
    expect(mergePersistedWallet({ network: "public", accounts: ["a"] }, current, "testnet")).toEqual({ network: "testnet", accounts: ["a"] });
    expect(mergePersistedWallet({ network: "public" }, current, "none").network).toBe("public");
    expect(mergePersistedWallet(undefined, current, "testnet")).toEqual(current);
  });
  it("the store's persist options use that merge", () => {
    expect(read("src/shared/store/wallet.ts")).toContain("merge: (persisted, current) => mergePersistedWallet(");
  });
});
