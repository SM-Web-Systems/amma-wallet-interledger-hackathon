import { keccak256, recoverTransactionAddress, type LocalAccount, type TransactionSerializableEIP1559 } from "viem";
import { normalizeAddress } from "./address";
import { parsePositiveUnits } from "./amounts";
import { ensure } from "./errors";
import { isAllowedTransferGas, type PreparedTransfer, type TransferIntent } from "./transfer";
import { enabledNetwork } from "./networks";

const UINT = /^(0|[1-9][0-9]*)$/;

/**
 * The signing boundary. It does not trust the review screen or the backend:
 * the prepared transaction must match the intent the user approved (network,
 * chain ID, sender, recipient, exact amount), be a plain transfer with no
 * calldata, stay within the gas and fee caps, and its totals must add up. Only then is the
 * key used. Platform code supplies the account from its own secure storage.
 */
export function assertMatchesIntent(intent: TransferIntent, prepared: PreparedTransfer): TransactionSerializableEIP1559 {
  const network = enabledNetwork(intent.networkId);
  ensure(prepared.networkId === network.id && prepared.chainId === network.chainId, "EVM_SIGN_NETWORK_MISMATCH");
  ensure(normalizeAddress(prepared.from) === normalizeAddress(intent.from), "EVM_SIGN_SENDER_MISMATCH");
  ensure(normalizeAddress(prepared.to) === normalizeAddress(intent.to), "EVM_SIGN_RECIPIENT_MISMATCH");
  for (const field of [prepared.valueWei, prepared.gasLimit, prepared.maxFeePerGasWei, prepared.maxPriorityFeePerGasWei, prepared.maxNetworkFeeWei, prepared.maxTotalWei]) {
    ensure(typeof field === "string" && UINT.test(field), "EVM_SIGN_MALFORMED");
  }
  const value = BigInt(prepared.valueWei);
  ensure(value === parsePositiveUnits(intent.amount, network.nativeAsset.decimals), "EVM_SIGN_AMOUNT_MISMATCH");
  const gas = BigInt(prepared.gasLimit);
  ensure(isAllowedTransferGas(gas), "EVM_SIGN_GAS_UNEXPECTED");
  const maxFee = BigInt(prepared.maxFeePerGasWei), tip = BigInt(prepared.maxPriorityFeePerGasWei);
  ensure(tip <= maxFee && maxFee <= network.maxFeePerGasCapWei, "EVM_SIGN_FEE_ABOVE_CAP");
  ensure(BigInt(prepared.maxNetworkFeeWei) === gas * maxFee, "EVM_SIGN_TOTAL_MISMATCH");
  ensure(BigInt(prepared.maxTotalWei) === value + gas * maxFee, "EVM_SIGN_TOTAL_MISMATCH");
  ensure(Number.isSafeInteger(prepared.nonce) && prepared.nonce >= 0, "EVM_NONCE_INVALID");
  return {
    type: "eip1559", chainId: network.chainId, to: normalizeAddress(prepared.to), value, nonce: prepared.nonce,
    gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, data: undefined, accessList: [],
  };
}

export interface SignedTransfer { readonly rawTransaction: `0x${string}`; readonly hash: `0x${string}` }

export async function signApprovedTransfer(account: LocalAccount, intent: TransferIntent, prepared: PreparedTransfer): Promise<SignedTransfer> {
  const transaction = assertMatchesIntent(intent, prepared);
  ensure(normalizeAddress(account.address) === normalizeAddress(intent.from), "EVM_SIGN_WRONG_KEY");
  ensure(account.signTransaction, "EVM_SIGNER_UNAVAILABLE");
  const rawTransaction = await account.signTransaction(transaction);
  // Defence in depth: the bytes leaving the signer must recover to the approved sender.
  const signer = await recoverTransactionAddress({ serializedTransaction: rawTransaction as never });
  ensure(normalizeAddress(signer) === normalizeAddress(intent.from), "EVM_SIGN_WRONG_KEY");
  return { rawTransaction, hash: keccak256(rawTransaction) };
}
