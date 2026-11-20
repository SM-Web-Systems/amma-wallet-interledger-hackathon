import { afterEach, describe, expect, it, vi } from "vitest";
import { evmCustodyName, evmCustodyReal, evmSymbol, moveToAmmaNote, custodyNetworkOk, evmExplorerName, evmExplorerTxUrl, mainnetCustodyBuild, XRP_NOT_ACTIVATED, xrpExplorerName, xrpExplorerTxUrl, xrplMainnetBuild, xrplNetworkShown, xrpNavLabel } from "./custody-network";

afterEach(() => vi.unstubAllEnvs());

describe("XRP on mainnet build flag (VITE_XRPL_MAINNET)", () => {
  it("testnet builds: XRP shown as before, testnet labels and explorer", () => {
    expect(xrplMainnetBuild()).toBe(false);
    expect(xrplNetworkShown()).toBe(true);
    expect(xrpNavLabel()).toBe("XRP Testnet");
    expect(xrpExplorerTxUrl()).toBe("https://testnet.xrpl.org/transactions/");
    expect(xrpExplorerName()).toBe("XRP testnet");
    vi.stubEnv("VITE_XRPL_MAINNET", "on");
    expect(xrplMainnetBuild()).toBe(false); // ignored without VITE_MAINNET_CUSTODY=on
    expect(xrpNavLabel()).toBe("XRP Testnet");
  });
  it("mainnet custody builds hide XRP unless VITE_XRPL_MAINNET is exactly on", () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    for (const v of ["", "true", "1", "ON"]) { vi.stubEnv("VITE_XRPL_MAINNET", v); expect(xrplNetworkShown()).toBe(false); expect(xrplMainnetBuild()).toBe(false); }
    vi.stubEnv("VITE_XRPL_MAINNET", "on");
    expect(xrplNetworkShown()).toBe(true);
    expect(xrpNavLabel()).toBe("XRP");
    expect(xrpExplorerTxUrl()).toBe("https://livenet.xrpl.org/transactions/");
    expect(xrpExplorerName()).toBe("XRP Ledger");
  });
  it("the not-activated copy never asks the user to send XRP", () => {
    expect(XRP_NOT_ACTIVATED).toBe("Not activated yet. This wallet is activated when you complete an eligible task.");
    expect(XRP_NOT_ACTIVATED).not.toMatch(/send|fund|deposit/i);
  });
});

describe("custody network flag", () => {
  it("is testnet-only by default", () => {
    expect(mainnetCustodyBuild()).toBe(false);
    expect(custodyNetworkOk("testnet")).toBe(true);
    expect(custodyNetworkOk("public")).toBe(false);
    expect(evmExplorerTxUrl()).toBe("https://sepolia.etherscan.io/tx/");
    expect(evmExplorerName()).toBe("Sepolia");
  });
  it("allows the public network only when VITE_MAINNET_CUSTODY is exactly on", () => {
    for (const v of ["true", "1", "off", "ON", ""]) { vi.stubEnv("VITE_MAINNET_CUSTODY", v); expect(custodyNetworkOk("public")).toBe(false); }
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    expect(custodyNetworkOk("public")).toBe(true);
    expect(custodyNetworkOk("testnet")).toBe(true);
    expect(evmExplorerTxUrl()).toBe("https://etherscan.io/tx/");
    expect(evmExplorerName()).toBe("Ethereum");
  });
});

describe("network-true Ethereum labels", () => {
  it("labels Amma-held Ethereum as Sepolia ETH on a testnet build", () => {
    expect(evmCustodyReal()).toBe(false);
    expect(evmCustodyReal("sepolia")).toBe(false);
    expect(evmCustodyName(false)).toBe("Sepolia ETH");
    expect(evmSymbol(false)).toBe("SepoliaETH");
  });
  it("labels Amma-held Ethereum as Ethereum (real ETH) on a mainnet custody build", () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    expect(evmCustodyReal()).toBe(true);
    expect(evmCustodyName(true)).toBe("Ethereum (real ETH)");
    expect(evmSymbol(true)).toBe("ETH");
  });
  it("labels as real ETH when the server says the wallet is on ethereum, even on a testnet build", () => {
    expect(evmCustodyReal("ethereum")).toBe(true);
  });
  it("move note: Testnet only on a testnet build for every chain", () => {
    for (const c of ["evm", "xrpl", "stellar"] as const) expect(moveToAmmaNote(c, "testnet")).toBe("Testnet only.");
  });
  it("move note: real money wording on a mainnet build, XRP stays honest", () => {
    vi.stubEnv("VITE_MAINNET_CUSTODY", "on");
    expect(moveToAmmaNote("evm")).toMatch(/real ETH/);
    expect(moveToAmmaNote("stellar", "public")).toMatch(/real XLM/);
    expect(moveToAmmaNote("stellar", "testnet")).toBe("Testnet only.");
    expect(moveToAmmaNote("xrpl")).toBe("XRP cannot be moved to Amma on this build.");
    vi.stubEnv("VITE_XRPL_MAINNET", "on");
    expect(moveToAmmaNote("xrpl")).toMatch(/real XRP/);
  });
});
