import { describe, expect, it } from "vitest";
import { assertXrplNetworkConfig, custodyNetworks, networksFor, xrplCustodyAllowed, xrplMainnetCustodyOn } from "./custody-networks";

describe("XRP on mainnet (XRPL_MAINNET_CUSTODY)", () => {
  const ON = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet", XRPL_MAINNET_CUSTODY: "on" };
  it("is on only with all four settings", () => {
    expect(xrplMainnetCustodyOn(ON)).toBe(true);
    expect(xrplMainnetCustodyOn({ ...ON, XRPL_MAINNET_CUSTODY: "true" })).toBe(false);
    expect(xrplMainnetCustodyOn({ ...ON, XRPL_NETWORK: "testnet" })).toBe(false);
    expect(xrplMainnetCustodyOn({ ...ON, MAINNET_CUSTODY: "off" })).toBe(false);
    expect(xrplMainnetCustodyOn({ ...ON, STELLAR_NETWORK: "testnet" })).toBe(false);
    expect(xrplMainnetCustodyOn({})).toBe(false);
  });
  it("accepts today's settings and the full mainnet set", () => {
    for (const env of [{}, { STELLAR_NETWORK: "testnet" }, { XRPL_NETWORK: "testnet" }, { STELLAR_NETWORK: "public" }, { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" },
      { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", XRPL_MAINNET_CUSTODY: "off" }, ON]) expect(() => assertXrplNetworkConfig(env)).not.toThrow();
  });
  it("refuses inconsistent combinations with a clear message", () => {
    expect(() => assertXrplNetworkConfig({ ...ON, XRPL_MAINNET_CUSTODY: "true" })).toThrow(/XRPL_MAINNET_CUSTODY must be on or off/);
    expect(() => assertXrplNetworkConfig({ ...ON, MAINNET_CUSTODY: "off" })).toThrow(/needs MAINNET_CUSTODY=on and STELLAR_NETWORK=public/);
    expect(() => assertXrplNetworkConfig({ ...ON, STELLAR_NETWORK: "testnet" })).toThrow(/needs MAINNET_CUSTODY=on and STELLAR_NETWORK=public/);
    expect(() => assertXrplNetworkConfig({ ...ON, XRPL_NETWORK: undefined })).toThrow(/needs XRPL_NETWORK=mainnet/);
    expect(() => assertXrplNetworkConfig({ ...ON, XRPL_MAINNET_CUSTODY: undefined })).toThrow(/XRPL_NETWORK=mainnet needs XRPL_MAINNET_CUSTODY=on/);
    expect(() => assertXrplNetworkConfig({ XRPL_NETWORK: "mainnet" })).toThrow(/XRPL_NETWORK=mainnet needs/);
    expect(() => assertXrplNetworkConfig({ XRPL_NETWORK: "devnet" })).toThrow(/XRPL_NETWORK must be testnet or mainnet/);
  });
  it("the routes' flags carry it: XRP custody on testnet, and on mainnet only with xrplMainnet", () => {
    expect(xrplCustodyAllowed({})).toBe(true);
    expect(xrplCustodyAllowed({ mainnet: true })).toBe(false);
    expect(xrplCustodyAllowed({ mainnet: true, xrplMainnet: true })).toBe(true);
    expect(networksFor({ mainnet: true, xrplMainnet: true }).xrpl).toBe("mainnet");
  });
});

describe("custodyNetworks", () => {
  it("is testnet unless MAINNET_CUSTODY is on and the server is on the public network", () => {
    const t = { mainnet: false, stellar: "testnet", xrpl: "testnet", evm: "sepolia", evmChainId: 11155111 };
    expect(custodyNetworks({})).toEqual(t);
    expect(custodyNetworks({ STELLAR_NETWORK: "testnet" })).toEqual(t);
    expect(custodyNetworks({ STELLAR_NETWORK: "public" })).toEqual(t);
    expect(custodyNetworks({ MAINNET_CUSTODY: "on" })).toEqual(t);
    expect(custodyNetworks({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "off" })).toEqual(t);
    expect(custodyNetworks({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "true" })).toEqual(t);
  });
  it("maps to public, mainnet, ethereum and chain 1 when on", () => {
    expect(custodyNetworks({ STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on" })).toEqual({ mainnet: true, stellar: "public", xrpl: "mainnet", evm: "ethereum", evmChainId: 1 });
  });
  it("follows the flags object the routes already carry", () => {
    expect(networksFor({}).evm).toBe("sepolia");
    expect(networksFor({ mainnet: false }).stellar).toBe("testnet");
    expect(networksFor({ mainnet: true }).evmChainId).toBe(1);
  });
});
