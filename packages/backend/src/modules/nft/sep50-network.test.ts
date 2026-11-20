import { describe, it, expect } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { knownSep50Contracts, normalizeNetwork, sorobanTargetFor } from "./sep50-network";

const LMS = "CDPKSOOE4UZFM4TS52H7LMP2TYNLJBFAMT6M4E2H67KZEAH6UF54H524";

describe("SEP-50 reads use the collection's own network", () => {
  it("a mainnet collection is read on mainnet even when SOROBAN_RPC_URL was left at the testnet default (the bug)", () => {
    const t = sorobanTargetFor("public", { STELLAR_NETWORK: "public", SOROBAN_RPC_URL: undefined });
    expect(t.rpcUrl).toBe("https://mainnet.sorobanrpc.com");
    expect(t.passphrase).toBe(StellarSdk.Networks.PUBLIC);
  });

  it("SOROBAN_RPC_URL is used only for the server's own network", () => {
    const env = { STELLAR_NETWORK: "testnet", SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org" };
    expect(sorobanTargetFor("public", env).rpcUrl).toBe("https://mainnet.sorobanrpc.com");
    expect(sorobanTargetFor("testnet", env).rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(sorobanTargetFor("testnet", env).passphrase).toBe(StellarSdk.Networks.TESTNET);
  });

  it("per-network overrides win", () => {
    expect(sorobanTargetFor("mainnet", { SOROBAN_RPC_URL_PUBLIC: "https://rpc.example" }).rpcUrl).toBe("https://rpc.example");
  });

  it("mainnet, public and pubnet all mean mainnet", () => {
    expect(["mainnet", "public", "PUBNET"].map(normalizeNetwork)).toEqual(["public", "public", "public"]);
    expect(normalizeNetwork(undefined)).toBe("testnet");
  });

  it("NFT_KNOWN_SEP50_CONTRACTS registers valid contracts and skips junk", () => {
    expect(knownSep50Contracts({ NFT_KNOWN_SEP50_CONTRACTS: `${LMS}@public, nonsense@public,` })).toEqual([{ contractId: LMS, network: "public" }]);
    expect(knownSep50Contracts({ NFT_KNOWN_SEP50_CONTRACTS: LMS, STELLAR_NETWORK: "public" })[0].network).toBe("public");
    expect(knownSep50Contracts({})).toEqual([]);
  });
});
