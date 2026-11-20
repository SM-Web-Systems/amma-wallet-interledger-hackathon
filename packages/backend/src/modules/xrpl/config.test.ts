import { describe, expect, it } from "vitest";
import { readMonitorConfig, readXrplConfig, readXrplIntegrationEnabled, readXrplRecoveryConfig, TESTNET_ENDPOINTS } from "./config";
import { classicAddress, destinationTag, drops, transactionHash } from "./validation";

describe("XRPL configuration and boundary validation", () => {
  it("keeps external application access disabled until payments are explicitly enabled",()=>{
    expect(readXrplIntegrationEnabled({})).toBe(false);
    expect(readXrplIntegrationEnabled({XRPL_ENABLED:"true",XRPL_PAYMENTS_ENABLED:"true",XRPL_INTEGRATION_ENABLED:"true"})).toBe(true);
    expect(()=>readXrplIntegrationEnabled({XRPL_INTEGRATION_ENABLED:"true"})).toThrow();
    expect(()=>readXrplIntegrationEnabled({XRPL_ENABLED:"true",XRPL_INTEGRATION_ENABLED:"true"})).toThrow();
    expect(()=>readXrplIntegrationEnabled({XRPL_INTEGRATION_ENABLED:"1"})).toThrow();
  });
  it("is disabled by default and independent of Stellar configuration", () => {
    expect(readXrplConfig({ STELLAR_NETWORK: "public" })).toEqual({ enabled: false, network: "testnet", endpoints: TESTNET_ENDPOINTS, timeoutMs: 10000, maxLedgerAgeSeconds: 30 });
    expect(Object.isFrozen(readXrplConfig({}).endpoints)).toBe(true);
  });
  it.each(["mainnet", "devnet", "public", ""])('rejects network "%s"', (network) => {
    expect(() => readXrplConfig({ XRPL_NETWORK: network })).toThrow();
  });
  describe("mainnet (XRPL_MAINNET_CUSTODY=on only)", () => {
    const ON = { STELLAR_NETWORK: "public", MAINNET_CUSTODY: "on", XRPL_NETWORK: "mainnet", XRPL_MAINNET_CUSTODY: "on", XRPL_ENABLED: "true", XRPL_MAINNET_WS: "wss://xrplcluster.com/" };
    it("reads the mainnet endpoints from XRPL_MAINNET_WS", () => {
      expect(readXrplConfig(ON)).toMatchObject({ enabled: true, network: "mainnet", endpoints: ["wss://xrplcluster.com/"] });
      expect(readXrplConfig({ ...ON, XRPL_MAINNET_WS: "wss://xrplcluster.com/,wss://s2.ripple.com/" }).endpoints).toEqual(["wss://xrplcluster.com/", "wss://s2.ripple.com/"]);
    });
    it("needs the switch, the mainnet custody mode and a wss:// endpoint", () => {
      expect(() => readXrplConfig({ ...ON, XRPL_MAINNET_CUSTODY: undefined })).toThrow(/XRPL_MAINNET_CUSTODY=on/);
      expect(() => readXrplConfig({ ...ON, MAINNET_CUSTODY: undefined })).toThrow(/MAINNET_CUSTODY=on/);
      expect(() => readXrplConfig({ ...ON, XRPL_MAINNET_WS: undefined })).toThrow(/XRPL_MAINNET_WS/);
      expect(() => readXrplConfig({ ...ON, XRPL_RPC_URLS: "wss://xrplcluster.com/" })).toThrow(/XRPL_RPC_URLS/);
    });
    it.each(["ws://xrplcluster.com/", "https://xrplcluster.com/", "wss://user:pw@xrplcluster.com/", "wss://xrplcluster.com/?k=1", "wss://xrplcluster.com/#x", ...TESTNET_ENDPOINTS, "wss://s.devnet.rippletest.net:51233/", "not a url"])("refuses mainnet endpoint %s", (endpoint) => {
      expect(() => readXrplConfig({ ...ON, XRPL_MAINNET_WS: endpoint })).toThrow();
    });
    it("refuses duplicate or more than two endpoints", () => {
      expect(() => readXrplConfig({ ...ON, XRPL_MAINNET_WS: "wss://a.example/,wss://a.example/" })).toThrow();
      expect(() => readXrplConfig({ ...ON, XRPL_MAINNET_WS: "wss://a.example/,wss://b.example/,wss://c.example/" })).toThrow();
    });
    it("keeps tenant integrations testnet-only; monitoring runs keyed on mainnet", () => {
      expect(() => readXrplIntegrationEnabled({ ...ON, XRPL_PAYMENTS_ENABLED: "true", XRPL_INTEGRATION_ENABLED: "true" })).toThrow(/testnet only/);
      expect(readXrplIntegrationEnabled({ ...ON, XRPL_PAYMENTS_ENABLED: "true" })).toBe(false);
      expect(readMonitorConfig({ ...ON, XRPL_MONITORING_ENABLED: "true" })).toMatchObject({ enabled: true, network: "mainnet" });
    });
    it("requires the recovery worker (XRPL_RECONCILIATION_ENABLED=true) under the switch", () => {
      expect(() => readXrplRecoveryConfig(ON)).toThrow(/XRPL_RECONCILIATION_ENABLED=true/);
      expect(() => readXrplRecoveryConfig({ ...ON, XRPL_RECONCILIATION_ENABLED: "false" })).toThrow(/XRPL_RECONCILIATION_ENABLED=true/);
      expect(readXrplRecoveryConfig({ ...ON, XRPL_RECONCILIATION_ENABLED: "true" }).enabled).toBe(true);
      expect(readXrplRecoveryConfig({}).enabled).toBe(false); // testnet: unchanged, optional
    });
  });
  it.each(["yes", "1", "TRUE", ""])('rejects ambiguous enabled value "%s"', (enabled) => {
    expect(() => readXrplConfig({ XRPL_ENABLED: enabled })).toThrow();
  });
  it.each(["ws://s.altnet.rippletest.net:51233", "wss://127.0.0.1/", "wss://s1.ripple.com/", "wss://s.altnet.rippletest.net:51233/?token=x", "wss://user:pass@testnet.xrpl-labs.com/", "wss://testnet.xrpl-labs.com/evil", "wss://testnet.xrpl-labs.com.evil.invalid/"])("rejects untrusted endpoint %s", (endpoint) => {
    expect(() => readXrplConfig({ XRPL_RPC_URLS: endpoint })).toThrow();
  });
  it("rejects duplicates and unbounded timeout/age settings", () => {
    expect(() => readXrplConfig({ XRPL_RPC_URLS: [TESTNET_ENDPOINTS[0], TESTNET_ENDPOINTS[0]].join(",") })).toThrow();
    expect(() => readXrplConfig({ XRPL_TIMEOUT_MS: "999999" })).toThrow();
    expect(() => readXrplConfig({ XRPL_TIMEOUT_MS: "1e3" })).toThrow();
    expect(() => readXrplConfig({ XRPL_MAX_LEDGER_AGE_SECONDS: "0" })).toThrow();
  });
  it("requires checksum-valid classic addresses without accepting secrets or X-addresses", () => {
    expect(classicAddress("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh")).toBe("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh");
    for (const value of ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi", "X-address", "secret", null, ""]) expect(() => classicAddress(value)).toThrow("INVALID_ADDRESS");
  });
  it("preserves tag zero, absence, uint32 bounds and rejects numeric strings", () => {
    expect(destinationTag(0)).toBe(0); expect(destinationTag(undefined)).toBeUndefined(); expect(destinationTag(0xffffffff)).toBe(0xffffffff);
    for (const value of [-1, 0x100000000, 0.5, "0", null, NaN]) expect(() => destinationTag(value)).toThrow("INVALID_TAG");
  });
  it("keeps large drops exact and rejects noncanonical or out-of-supply values", () => {
    expect(drops("9007199254740993")).toBe(9007199254740993n);
    for (const value of [1, "1.5", "1e6", "01", "-1", "100000000000000001", null]) expect(() => drops(value)).toThrow();
    expect(() => drops("0", true)).toThrow();
    expect(transactionHash("a".repeat(64))).toBe("A".repeat(64));
    expect(() => transactionHash("a".repeat(63))).toThrow("INVALID_HASH");
  });
});
