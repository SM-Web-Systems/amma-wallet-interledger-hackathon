/**
 * Stellar wallet passphrase rule, the same as the web app and the XRP and
 * Ethereum vaults (audit F-2 / TODO D2). A short PIN could be guessed offline
 * from the encrypted key; 12+ characters cannot be in practice. Wallets made
 * with an older 6+ character PIN no longer unlock with it: the PIN may only
 * move the wallet into the Amma account (lib/pin-retire.ts).
 */
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 128;

/** A sentence describing what is wrong, or null when the passphrase is acceptable. */
export function passphraseProblem(passphrase: string): string | null {
  if (!passphrase || passphrase.trim().length < PASSPHRASE_MIN) return `Use at least ${PASSPHRASE_MIN} characters.`;
  if (passphrase.length > PASSPHRASE_MAX) return `Use at most ${PASSPHRASE_MAX} characters.`;
  if (/^\d+$/.test(passphrase)) return "Use words or letters, not only numbers.";
  return null;
}

/** True for a secret set under the old PIN rule (anything that fails the passphrase rule). */
export function isLegacyPin(secret: string): boolean {
  return passphraseProblem(secret) !== null;
}
