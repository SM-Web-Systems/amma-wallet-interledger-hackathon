import * as StellarSdk from "@stellar/stellar-sdk";

/**
 * Which Soroban RPC and passphrase to use for a collection, from the collection's own network.
 *
 * Before this, every Soroban read used SOROBAN_RPC_URL (testnet by default) and picked the passphrase from STELLAR_NETWORK.
 * A mainnet contract registered on a server whose SOROBAN_RPC_URL was left at the testnet default was read on testnet,
 * every simulation failed, and the failure was swallowed as "no owner". That is one of the two reasons certificate NFTs
 * did not show in the wallet.
 */
type Env = Record<string, string | undefined>;

export type Sep50Network = "public" | "testnet";

const DEFAULT_RPC: Record<Sep50Network, string> = {
  public: "https://mainnet.sorobanrpc.com",
  testnet: "https://soroban-testnet.stellar.org",
};

/** "public", "mainnet" and "pubnet" mean mainnet; anything else is testnet. */
export function normalizeNetwork(value: string | null | undefined): Sep50Network {
  const v = (value || "").toLowerCase();
  return v === "public" || v === "mainnet" || v === "pubnet" ? "public" : "testnet";
}

export function sorobanTargetFor(network: string | null | undefined, env: Env = process.env): { network: Sep50Network; rpcUrl: string; passphrase: string } {
  const n = normalizeNetwork(network);
  const perNetwork = n === "public" ? env.SOROBAN_RPC_URL_PUBLIC : env.SOROBAN_RPC_URL_TESTNET;
  // SOROBAN_RPC_URL still counts, but only for the network the server itself runs on.
  const serverDefault = normalizeNetwork(env.STELLAR_NETWORK) === n ? env.SOROBAN_RPC_URL : undefined;
  return {
    network: n,
    rpcUrl: perNetwork || serverDefault || DEFAULT_RPC[n],
    passphrase: n === "public" ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET,
  };
}

/**
 * Contracts that are always listed in owners' wallets, from NFT_KNOWN_SEP50_CONTRACTS,
 * written as "CONTRACTID@public,CONTRACTID2@testnet". A contract with no "@network" uses the server's STELLAR_NETWORK.
 * Bad entries are skipped, never fatal.
 */
export function knownSep50Contracts(env: Env = process.env): Array<{ contractId: string; network: Sep50Network }> {
  const raw = env.NFT_KNOWN_SEP50_CONTRACTS || "";
  const out: Array<{ contractId: string; network: Sep50Network }> = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [contractId, net] = part.split("@");
    if (!StellarSdk.StrKey.isValidContract(contractId)) continue;
    out.push({ contractId, network: normalizeNetwork(net ?? env.STELLAR_NETWORK) });
  }
  return out;
}
