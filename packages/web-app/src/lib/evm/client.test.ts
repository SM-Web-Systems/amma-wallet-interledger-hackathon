import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function load() { vi.resetModules(); return import("./client"); }
const dump = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : typeof x === "function" ? undefined : x));

describe("custodyReader", () => {
  it("reads Amma wallets from Sepolia in a testnet build", async () => {
    vi.stubEnv("VITE_EVM_SEPOLIA_RPC_URLS", "https://s.invalid");
    vi.stubEnv("VITE_EVM_MAINNET_RPC_URLS", "https://m.invalid");
    const { custodyReader } = await load();
    const text = dump(custodyReader());
    expect(text).toContain("s.invalid");
    expect(text).not.toContain("m.invalid");
  });
  it("reads from Ethereum mainnet in a mainnet custody build, and never falls back to the Sepolia RPC", async () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    vi.stubEnv("VITE_EVM_SEPOLIA_RPC_URLS", "https://s.invalid");
    expect((await load()).custodyReader()).toBeNull();
    vi.stubEnv("VITE_EVM_MAINNET_RPC_URLS", "https://m.invalid");
    const text = dump((await load()).custodyReader());
    expect(text).toContain("m.invalid");
    expect(text).not.toContain("s.invalid");
  });
});
