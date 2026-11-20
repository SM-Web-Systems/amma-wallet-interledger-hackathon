import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { ensure } from "./errors";

/**
 * BIP-39 / BIP-44 Ethereum derivation, m/44'/60'/0'/0/{index}, the path used
 * by mainstream Ethereum wallets so users can restore elsewhere.
 *
 * Recovery-compatibility decision (open, see docs/evm/DESIGN.md): whether an
 * existing Amma Stellar mnemonic (SEP-0005, m/44'/148'/x') may also seed EVM
 * accounts. This function only performs the standard derivation; it never
 * reinterprets an XRPL family seed or a raw Stellar secret key.
 */
export const ETHEREUM_PATH_PREFIX = "m/44'/60'/0'/0/";

export function deriveEvmAccount(mnemonic: string, index = 0): HDAccount {
  ensure(Number.isSafeInteger(index) && index >= 0 && index < 2 ** 31, "EVM_DERIVATION_INDEX_INVALID");
  return mnemonicToAccount(normalizeMnemonic(mnemonic), { path: `${ETHEREUM_PATH_PREFIX}${index}` as `m/44'/60'/${string}` });
}

/** Recovery phrase lengths offered to people: 12 words (128-bit) or 24 words (256-bit). */
export type MnemonicWordCount = 12 | 24;

/** A new English BIP-39 mnemonic from the platform CSPRNG (WebCrypto via @noble). 12 words unless 24 is asked for. */
export function createMnemonic(wordCount: MnemonicWordCount = 12): string {
  ensure(wordCount === 12 || wordCount === 24, "EVM_MNEMONIC_LENGTH_INVALID");
  return generateMnemonic(wordlist, wordCount === 24 ? 256 : 128);
}

/** Canonical form used for storage and derivation, or throws EVM_MNEMONIC_INVALID. */
export function normalizeMnemonic(mnemonic: string): string {
  const normalized = mnemonic.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
  ensure(validateMnemonic(normalized, wordlist), "EVM_MNEMONIC_INVALID");
  return normalized;
}
