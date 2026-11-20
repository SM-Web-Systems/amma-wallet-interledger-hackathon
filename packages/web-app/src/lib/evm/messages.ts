import { EvmError } from "@amma-wallet/evm-core";
import { VaultError } from "./vault";

/** User-facing text for an Ethereum wallet error. Never shows a raw engine code. `real`: the error came from an Amma-held wallet on Ethereum mainnet, so RPC errors say Ethereum, not Sepolia. */
export function explain(cause: unknown, real = false): string {
  const code = cause instanceof EvmError || cause instanceof VaultError ? (cause as { code?: string }).code ?? cause.message : "";
  const messages: Record<string, string> = {
    WEAK_PASSPHRASE: "Use 12–128 characters, not only digits or spaces.",
    BACKUP_REQUIRED: "Write the recovery phrase down, tick the backup box and re-enter it exactly.",
    INVALID_MNEMONIC: "Enter a valid 12 or 24 word recovery phrase.",
    INVALID_NAME: "Choose a wallet name of 1–64 characters.",
    UNLOCK_FAILED: "The passphrase is incorrect or the vault was changed.",
    RESTORE_REQUIRED: "No encrypted wallet on this device. Restore it with your recovery phrase.",
    CORRUPT_VAULT: "This local vault cannot be verified. Restore it with your recovery phrase.",
    STORAGE_UNAVAILABLE: "Encrypted browser storage is unavailable.",
    EVM_INSUFFICIENT_FUNDS: "The amount plus the maximum network fee is more than the balance.",
    EVM_ADDRESS_INVALID: "Enter a 0x Ethereum address.",
    EVM_ADDRESS_CHECKSUM: "That address has a checksum error. Check it for a typo.",
    EVM_ADDRESS_ZERO: "That is the zero address. Anything sent there is lost, so it is blocked.",
    EVM_AMOUNT_INVALID: "Enter an amount like 0.01.",
    EVM_AMOUNT_TOO_PRECISE: "Use at most 18 decimal places.",
    EVM_AMOUNT_NOT_POSITIVE: "Enter an amount above zero.",
    EVM_AMOUNT_NEGATIVE: "Enter an amount above zero.",
    EVM_AMOUNT_TOO_LARGE: "That amount is too large.",
    EVM_MNEMONIC_INVALID: "Enter a valid 12 or 24 word recovery phrase.",
    EVM_FEE_ABOVE_CAP: "Sepolia fees are above this wallet's safety cap right now. Try later.",
    EVM_GAS_ESTIMATE_FAILED: "The network could not price this transfer. Check the amount leaves room for the fee, then try again.",
    EVM_GAS_ABOVE_CAP: "This transfer needs more gas than this wallet allows, so it was not prepared.",
    EVM_RPC_WRONG_CHAIN: "The configured RPC is not on Sepolia, so it was not used.",
    EVM_RPC_UNAVAILABLE: "Sepolia RPC is unavailable. Try again.",
    EVM_EARLIER_TRANSFER_UNRESOLVED: "Wait until the previous transfer is resolved.",
    EVM_CANCEL_TOO_LATE: "That transfer's nonce is already used on chain, so there is nothing left to cancel.",
    EVM_CANCEL_ALREADY_SENT: "A cancel for this transfer was already sent. Wait for one of them to land.",
    EVM_CANCEL_NOT_APPLICABLE: "Only an unresolved transfer can be cancelled.",
    CORRUPT_TRANSFER: "A saved transfer on this device cannot be verified. Check the explorer before sending again.",
  };
  if (real) {
    if (code === "EVM_RPC_WRONG_CHAIN") return "The configured RPC is not on Ethereum, so it was not used.";
    if (code.startsWith("EVM_RPC_")) return "The Ethereum RPC is unavailable. Try again.";
  }
  if (code && messages[code]) return messages[code];
  // Never show a raw engine code. Signing checks stop a transfer before it is sent.
  if (code.startsWith("EVM_SIGN_")) return "The signed transfer did not match what you approved, so it was not sent.";
  if (code.startsWith("EVM_RPC_")) return messages.EVM_RPC_UNAVAILABLE;
  if (code.startsWith("EVM_")) return `This could not be completed (${code}). Nothing was sent.`;
  const text = code ? (cause as Error).message : "Something went wrong. Your recovery phrase stays on this device.";
  return text;
}
