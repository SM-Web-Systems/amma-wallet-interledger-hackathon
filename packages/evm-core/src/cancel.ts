import { keccak256, parseTransaction, recoverTransactionAddress, type LocalAccount, type TransactionSerializableEIP1559 } from "viem";
import { normalizeAddress } from "./address";
import { formatUnits } from "./amounts";
import { ensure, EvmError } from "./errors";
import { quoteFees } from "./fees";
import { enabledNetwork, type NetworkId } from "./networks";
import type { SignedTransfer } from "./signing";
import { NATIVE_TRANSFER_GAS } from "./transfer";

/**
 * Cancelling a stuck transfer: a zero-value transaction from the wallet to
 * itself with the SAME nonce and higher fees. At most one of the two can ever
 * be included, so a cancel can never pay twice; if the original lands first
 * the cancel simply becomes "replaced". This is the only way the wallet signs
 * a second transaction for a nonce, and only after the user approves it.
 *
 * Nodes accept a replacement only if both fee fields rise by at least 10%, so
 * the cancel pays at least that bump, or the current market quote if higher.
 */
export interface CancelIntent {
  readonly networkId: NetworkId;
  readonly from: string;
  readonly nonce: number;
  /** Fees of the transaction being replaced, as signed. Decimal wei strings. */
  readonly original: { readonly maxFeePerGasWei: string; readonly maxPriorityFeePerGasWei: string };
}

export interface PreparedCancel {
  readonly kind: "cancel";
  readonly networkId: NetworkId;
  readonly chainId: number;
  readonly from: `0x${string}`;
  readonly to: `0x${string}`;
  readonly valueWei: "0";
  readonly nonce: number;
  readonly gasLimit: string;
  readonly maxFeePerGasWei: string;
  readonly maxPriorityFeePerGasWei: string;
  readonly maxNetworkFeeWei: string;
  readonly display: { readonly maxNetworkFee: string; readonly symbol: string };
}

export interface CancelState {
  readonly balanceWei: bigint;
  readonly baseFeeWei: bigint;
  readonly priorityFeeWei: bigint;
  /** Count of mined transactions from the sender: if it is past the nonce, there is nothing left to cancel. */
  readonly minedNonce: number;
}

const UINT = /^(0|[1-9][0-9]*)$/;
const bump = (value: bigint) => value + value / 10n + 1n;

function originalFees(intent: CancelIntent) {
  const { maxFeePerGasWei, maxPriorityFeePerGasWei } = intent.original;
  ensure(typeof maxFeePerGasWei === "string" && UINT.test(maxFeePerGasWei) && typeof maxPriorityFeePerGasWei === "string" && UINT.test(maxPriorityFeePerGasWei), "EVM_CANCEL_INVALID");
  const maxFee = BigInt(maxFeePerGasWei), tip = BigInt(maxPriorityFeePerGasWei);
  ensure(tip <= maxFee && maxFee > 0n, "EVM_CANCEL_INVALID");
  return { maxFee, tip };
}

export function prepareCancel(intent: CancelIntent, state: CancelState): PreparedCancel {
  const network = enabledNetwork(intent.networkId);
  const from = normalizeAddress(intent.from);
  ensure(Number.isSafeInteger(intent.nonce) && intent.nonce >= 0, "EVM_NONCE_INVALID");
  ensure(Number.isSafeInteger(state.minedNonce) && state.minedNonce >= 0, "EVM_NONCE_INVALID");
  ensure(state.minedNonce <= intent.nonce, "EVM_CANCEL_TOO_LATE");
  const original = originalFees(intent);
  const market = quoteFees(network, state.baseFeeWei, state.priorityFeeWei);
  const tip = market.maxPriorityFeePerGasWei > bump(original.tip) ? market.maxPriorityFeePerGasWei : bump(original.tip);
  let maxFee = market.maxFeePerGasWei > bump(original.maxFee) ? market.maxFeePerGasWei : bump(original.maxFee);
  if (maxFee < tip) maxFee = tip;
  ensure(maxFee <= network.maxFeePerGasCapWei, "EVM_FEE_ABOVE_CAP");
  const maxNetworkFee = NATIVE_TRANSFER_GAS * maxFee;
  ensure(maxNetworkFee <= state.balanceWei, "EVM_INSUFFICIENT_FUNDS");
  return Object.freeze({
    kind: "cancel", networkId: network.id, chainId: network.chainId, from, to: from, valueWei: "0", nonce: intent.nonce,
    gasLimit: NATIVE_TRANSFER_GAS.toString(), maxFeePerGasWei: maxFee.toString(), maxPriorityFeePerGasWei: tip.toString(),
    maxNetworkFeeWei: maxNetworkFee.toString(),
    display: Object.freeze({ maxNetworkFee: formatUnits(maxNetworkFee, network.nativeAsset.decimals), symbol: network.nativeAsset.symbol }),
  } as const);
}

/** The signing boundary for a cancel: self-addressed, zero value, the approved nonce, and a real fee bump. */
export function assertMatchesCancel(intent: CancelIntent, prepared: PreparedCancel): TransactionSerializableEIP1559 {
  const network = enabledNetwork(intent.networkId);
  const from = normalizeAddress(intent.from);
  ensure(prepared.kind === "cancel" && prepared.networkId === network.id && prepared.chainId === network.chainId, "EVM_SIGN_NETWORK_MISMATCH");
  ensure(normalizeAddress(prepared.from) === from && normalizeAddress(prepared.to) === from, "EVM_SIGN_RECIPIENT_MISMATCH");
  ensure(prepared.valueWei === "0", "EVM_SIGN_AMOUNT_MISMATCH");
  ensure(Number.isSafeInteger(intent.nonce) && prepared.nonce === intent.nonce, "EVM_SIGN_NONCE_MISMATCH");
  for (const field of [prepared.gasLimit, prepared.maxFeePerGasWei, prepared.maxPriorityFeePerGasWei, prepared.maxNetworkFeeWei]) {
    ensure(typeof field === "string" && UINT.test(field), "EVM_SIGN_MALFORMED");
  }
  ensure(BigInt(prepared.gasLimit) === NATIVE_TRANSFER_GAS, "EVM_SIGN_GAS_UNEXPECTED");
  const maxFee = BigInt(prepared.maxFeePerGasWei), tip = BigInt(prepared.maxPriorityFeePerGasWei);
  ensure(tip <= maxFee && maxFee <= network.maxFeePerGasCapWei, "EVM_SIGN_FEE_ABOVE_CAP");
  const original = originalFees(intent);
  ensure(maxFee >= bump(original.maxFee) && tip >= bump(original.tip), "EVM_CANCEL_FEE_TOO_LOW");
  ensure(BigInt(prepared.maxNetworkFeeWei) === NATIVE_TRANSFER_GAS * maxFee, "EVM_SIGN_TOTAL_MISMATCH");
  return {
    type: "eip1559", chainId: network.chainId, to: from, value: 0n, nonce: prepared.nonce,
    gas: NATIVE_TRANSFER_GAS, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, data: undefined, accessList: [],
  };
}

export async function signApprovedCancel(account: LocalAccount, intent: CancelIntent, prepared: PreparedCancel): Promise<SignedTransfer> {
  const transaction = assertMatchesCancel(intent, prepared);
  ensure(normalizeAddress(account.address) === normalizeAddress(intent.from), "EVM_SIGN_WRONG_KEY");
  ensure(account.signTransaction, "EVM_SIGNER_UNAVAILABLE");
  const rawTransaction = await account.signTransaction(transaction);
  const signer = await recoverTransactionAddress({ serializedTransaction: rawTransaction as never });
  ensure(normalizeAddress(signer) === normalizeAddress(intent.from), "EVM_SIGN_WRONG_KEY");
  return { rawTransaction, hash: keccak256(rawTransaction) };
}

/**
 * The cancel intent for a transfer this wallet signed, read from its own signed
 * bytes (so the fee bump is computed from what was actually broadcast).
 */
export async function cancelIntentFor(networkId: NetworkId, from: string, nonce: number, rawTransaction: `0x${string}`): Promise<CancelIntent> {
  const network = enabledNetwork(networkId);
  let tx: ReturnType<typeof parseTransaction>;
  try { tx = parseTransaction(rawTransaction); } catch { throw new EvmError("EVM_CANCEL_INVALID"); }
  ensure(tx.type === "eip1559" && tx.chainId === network.chainId && tx.nonce === nonce
    && tx.maxFeePerGas !== undefined && tx.maxPriorityFeePerGas !== undefined, "EVM_CANCEL_INVALID");
  const signer = await recoverTransactionAddress({ serializedTransaction: rawTransaction as never });
  ensure(normalizeAddress(signer) === normalizeAddress(from), "EVM_CANCEL_INVALID");
  return { networkId: network.id, from: normalizeAddress(from), nonce,
    original: { maxFeePerGasWei: tx.maxFeePerGas.toString(), maxPriorityFeePerGasWei: tx.maxPriorityFeePerGas.toString() } };
}
