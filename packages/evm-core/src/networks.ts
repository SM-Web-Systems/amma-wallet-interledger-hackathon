import { ensure } from "./errors";

/**
 * Network registry. A matching EVM address does not identify a network: every
 * balance, nonce and history lookup is keyed by `networkId` and verified
 * against the RPC's `eth_chainId` before use.
 *
 * Only Ethereum Sepolia is enabled. Mainnet entries exist so code can refuse
 * them by name; enabling one is a separate, reviewed release decision. Further
 * EVM networks (Base, Arbitrum, Optimism, Polygon, Avalanche C-Chain, BNB Chain,
 * Celo) are added here, disabled, when their adapter work starts, with chain IDs
 * re-verified from primary documentation at that time.
 */
export type NetworkId = "ethereum-mainnet" | "ethereum-sepolia";

export interface EvmNetwork {
  readonly id: NetworkId;
  readonly chainId: number;
  readonly family: "ethereum";
  readonly environment: "mainnet" | "testnet";
  readonly displayName: string;
  readonly nativeAsset: { readonly symbol: string; readonly decimals: 18 };
  /** Blocks after inclusion before a transfer is shown as confirmed. */
  readonly confirmations: number;
  /** Hard ceiling on maxFeePerGas the signer will ever approve, in wei. */
  readonly maxFeePerGasCapWei: bigint;
  readonly enabled: boolean;
  readonly explorerTxUrl: string;
}

const GWEI = 1_000_000_000n;

export const NETWORKS: Readonly<Record<NetworkId, EvmNetwork>> = Object.freeze({
  "ethereum-mainnet": Object.freeze({
    id: "ethereum-mainnet", chainId: 1, family: "ethereum", environment: "mainnet", displayName: "Ethereum",
    nativeAsset: Object.freeze({ symbol: "ETH", decimals: 18 as const }), confirmations: 12,
    maxFeePerGasCapWei: 500n * GWEI, enabled: false, explorerTxUrl: "https://etherscan.io/tx/",
  }),
  "ethereum-sepolia": Object.freeze({
    id: "ethereum-sepolia", chainId: 11155111, family: "ethereum", environment: "testnet", displayName: "Ethereum Sepolia",
    nativeAsset: Object.freeze({ symbol: "SepoliaETH", decimals: 18 as const }), confirmations: 3,
    maxFeePerGasCapWei: 1000n * GWEI, enabled: true, explorerTxUrl: "https://sepolia.etherscan.io/tx/",
  }),
});

/** Returns an enabled network or throws. Unknown ids and disabled networks are refused alike. */
export function enabledNetwork(id: string): EvmNetwork {
  const network = Object.hasOwn(NETWORKS, id) ? (NETWORKS as Record<string, EvmNetwork>)[id] : undefined;
  ensure(network, "EVM_NETWORK_UNKNOWN");
  ensure(network.enabled, "EVM_NETWORK_DISABLED");
  return network;
}

/** The RPC must report the chain the registry expects; otherwise nothing it says is used. */
export function assertRpcChain(network: EvmNetwork, reportedChainId: number | bigint | string): void {
  const reported = typeof reportedChainId === "string" ? BigInt(reportedChainId) : BigInt(reportedChainId);
  ensure(reported === BigInt(network.chainId), "EVM_RPC_WRONG_CHAIN");
}
