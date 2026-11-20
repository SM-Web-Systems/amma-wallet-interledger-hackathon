import { ensure } from "./errors";
import type { EvmNetwork } from "./networks";

export interface FeeQuote { readonly maxFeePerGasWei: bigint; readonly maxPriorityFeePerGasWei: bigint }

/**
 * EIP-1559 fee policy: allow the base fee to double before the transaction
 * stops being includable, plus the priority tip. The network's hard cap bounds
 * the result; a market above the cap is refused rather than silently capped
 * into a transaction that would sit pending.
 */
export function quoteFees(network: EvmNetwork, baseFeeWei: bigint, priorityFeeWei: bigint): FeeQuote {
  ensure(baseFeeWei > 0n && priorityFeeWei >= 0n, "EVM_FEE_INVALID");
  ensure(priorityFeeWei <= baseFeeWei * 10n + 10n ** 10n, "EVM_PRIORITY_FEE_UNREASONABLE");
  const maxFeePerGasWei = baseFeeWei * 2n + priorityFeeWei;
  ensure(maxFeePerGasWei <= network.maxFeePerGasCapWei, "EVM_FEE_ABOVE_CAP");
  return { maxFeePerGasWei, maxPriorityFeePerGasWei: priorityFeeWei };
}
