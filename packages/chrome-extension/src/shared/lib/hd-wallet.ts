import StellarHDWallet from "stellar-hd-wallet";
import { generateMnemonic, validateMnemonic } from "bip39";

/** Recovery phrase lengths Amma offers. 24 words (256-bit) is the SEP-0005 recommendation. */
export const RECOVERY_WORD_COUNTS = [12, 24] as const;
export type RecoveryWordCount = (typeof RECOVERY_WORD_COUNTS)[number];

/**
 * A new BIP-39 English recovery phrase from the browser CSPRNG.
 * 12 words = 128 bits of entropy, 24 words = 256 bits.
 */
export function generateRecoveryPhrase(wordCount: RecoveryWordCount = 24): string {
  if (!RECOVERY_WORD_COUNTS.includes(wordCount)) {
    throw new Error("A recovery phrase must be 12 or 24 words");
  }
  return generateMnemonic(wordCount === 24 ? 256 : 128);
}

/**
 * Canonical form of a typed or pasted phrase: Unicode NFKD, lower case, single
 * spaces. People paste phrases with capitals, double spaces or line breaks;
 * without this, a correct phrase is rejected as invalid.
 */
export function normalizeMnemonic(mnemonic: string): string {
  return (mnemonic ?? "").normalize("NFKD").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Derive a Stellar keypair from a BIP39 mnemonic using SEP-0005 path (m/44'/148'/index').
 * All derivation happens client-side — the mnemonic never leaves the browser.
 */
export function deriveHDKeypair(
  mnemonic: string,
  accountIndex: number = 0
): { publicKey: string; secretKey: string } {
  const phrase = normalizeMnemonic(mnemonic);
  if (!phrase || !validateMnemonic(phrase)) {
    throw new Error("Invalid mnemonic phrase");
  }
  const wallet = StellarHDWallet.fromMnemonic(phrase);
  return {
    publicKey: wallet.getPublicKey(accountIndex),
    secretKey: wallet.getSecret(accountIndex),
  };
}

/**
 * Validate a BIP39 mnemonic phrase client-side.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  const phrase = normalizeMnemonic(mnemonic);
  if (!phrase) return false;
  return validateMnemonic(phrase);
}
