/** Wallet passphrase rule, the same on web, extension and mobile (audit D8). */
export const PASSPHRASE_MIN = 12;
export const PASSPHRASE_MAX = 128;

/** A sentence describing what is wrong, or null when the passphrase is acceptable. */
export function passphraseProblem(passphrase: string): string | null {
  if (!passphrase || passphrase.trim().length < PASSPHRASE_MIN) return `Use at least ${PASSPHRASE_MIN} characters.`;
  if (passphrase.length > PASSPHRASE_MAX) return `Use at most ${PASSPHRASE_MAX} characters.`;
  if (/^\d+$/.test(passphrase)) return "Use words or letters, not only numbers.";
  return null;
}

/** True for a secret set under the old PIN rule, which should be upgraded. */
export function isLegacyPin(secret: string): boolean {
  return passphraseProblem(secret) !== null;
}

/** What is wrong with a change-passphrase form, or null when it can be submitted. */
export function changePassphraseProblem(current: string, next: string, confirm: string): string | null {
  if (!current) return "Enter your current passphrase.";
  const weak = passphraseProblem(next);
  if (weak) return weak;
  if (next === current) return "Choose a different passphrase from the current one.";
  if (next !== confirm) return "The two new passphrases do not match.";
  return null;
}
