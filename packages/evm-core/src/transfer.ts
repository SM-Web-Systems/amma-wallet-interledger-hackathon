import { normalizeAddress } from "./address";
import { formatUnits, parsePositiveUnits } from "./amounts";
import { ensure } from "./errors";
import { quoteFees } from "./fees";
import { enabledNetwork, type NetworkId } from "./networks";

/**
 * Gas for a zero-value self-send (used by cancels). Plain transfers do not use a
 * fixed limit: since the state-growth repricing, sending value to an address
 * that does not exist yet costs far more than 21,000 gas, so a fixed limit made
 * every first send to a new address fail on chain.
 */
export const NATIVE_TRANSFER_GAS = 21_000n;
/** Highest gas limit a plain transfer may use. A larger estimate is refused, never truncated. */
export const MAX_TRANSFER_GAS = 300_000n;

/** The provider's eth_estimateGas for the exact transfer, plus a 20% margin, capped. */
export function transferGasLimit(estimate: bigint): bigint {
  ensure(estimate > 0n, "EVM_GAS_ESTIMATE_INVALID");
  ensure(estimate <= MAX_TRANSFER_GAS, "EVM_GAS_ABOVE_CAP");
  const padded = (estimate * 12n + 9n) / 10n;
  return padded > MAX_TRANSFER_GAS ? MAX_TRANSFER_GAS : padded;
}

/** A gas limit the signer accepts for a plain transfer. */
export function isAllowedTransferGas(gasLimit: bigint): boolean {
  return gasLimit > 0n && gasLimit <= MAX_TRANSFER_GAS;
}

/** What the user approves on screen. Amounts are decimal strings in the native unit. */
export interface TransferIntent { readonly networkId: NetworkId; readonly from: string; readonly to: string; readonly amount: string }

/** Everything needed to sign, plus the totals the review screen must show. Wei values are decimal strings. */
export interface PreparedTransfer {
  readonly networkId: NetworkId;
  readonly chainId: number;
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly valueWei: string;
  readonly nonce: number;
  readonly gasLimit: string;
  readonly maxFeePerGasWei: string;
  readonly maxPriorityFeePerGasWei: string;
  /** gasLimit x maxFeePerGas: the most the network fee can be. */
  readonly maxNetworkFeeWei: string;
  /** value + maxNetworkFee: what the balance must cover. */
  readonly maxTotalWei: string;
  readonly display: { readonly amount: string; readonly maxNetworkFee: string; readonly maxTotal: string; readonly symbol: string };
}

export interface ChainState {
  readonly nonce: number; readonly balanceWei: bigint; readonly baseFeeWei: bigint; readonly priorityFeeWei: bigint;
  /** eth_estimateGas for this exact from/to/value. */
  readonly gasEstimate: bigint;
}

export function prepareNativeTransfer(intent: TransferIntent, state: ChainState): PreparedTransfer {
  const network = enabledNetwork(intent.networkId);
  const from = normalizeAddress(intent.from);
  const to = normalizeAddress(intent.to);
  const value = parsePositiveUnits(intent.amount, network.nativeAsset.decimals);
  ensure(Number.isSafeInteger(state.nonce) && state.nonce >= 0, "EVM_NONCE_INVALID");
  ensure(state.balanceWei >= 0n, "EVM_BALANCE_INVALID");
  const fees = quoteFees(network, state.baseFeeWei, state.priorityFeeWei);
  const gasLimit = transferGasLimit(state.gasEstimate);
  const maxNetworkFee = gasLimit * fees.maxFeePerGasWei;
  const maxTotal = value + maxNetworkFee;
  ensure(maxTotal <= state.balanceWei, "EVM_INSUFFICIENT_FUNDS");
  const decimals = network.nativeAsset.decimals;
  return Object.freeze({
    networkId: network.id, chainId: network.chainId, from, to,
    valueWei: value.toString(), nonce: state.nonce, gasLimit: gasLimit.toString(),
    maxFeePerGasWei: fees.maxFeePerGasWei.toString(), maxPriorityFeePerGasWei: fees.maxPriorityFeePerGasWei.toString(),
    maxNetworkFeeWei: maxNetworkFee.toString(), maxTotalWei: maxTotal.toString(),
    display: Object.freeze({
      amount: formatUnits(value, decimals), maxNetworkFee: formatUnits(maxNetworkFee, decimals),
      maxTotal: formatUnits(maxTotal, decimals), symbol: network.nativeAsset.symbol,
    }),
  });
}
