/**
 * Opens the encrypted key copy that the server stores for a delegated wallet.
 *
 * Format (same as the web app and the server): base64(salt 16 + iv 12 + AES-256-GCM
 * ciphertext + tag), key = PBKDF2-SHA256(passphrase, salt, 600,000 rounds). The
 * passphrase is the one used on the device that made the wallet. Nothing here logs
 * or stores the result; the caller seals it into the vault straight away.
 */
import { gcm } from "@noble/ciphers/aes";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { utf8ToBytes, bytesToUtf8 } from "@noble/ciphers/utils";
import { pbkdf2Sha256 } from "./pbkdf2";

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
export const BACKUP_ITERATIONS = 600_000;
/** Tests lower this to stay fast; the real value is fixed by the format above. */
export const backupConfig = { iterations: BACKUP_ITERATIONS };

const BAD_COPY = "The stored copy of this key is damaged, so it cannot be restored from the backup.";

export async function openBackupSecret(
  encrypted: string,
  passphrase: string,
  iterations: number = backupConfig.iterations
): Promise<string> {
  let combined: Uint8Array;
  try {
    if (!encrypted || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new Error("bad");
    const raw = atob(encrypted);
    combined = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    throw new Error(BAD_COPY);
  }
  if (combined.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1) throw new Error(BAD_COPY);

  const salt = combined.slice(0, SALT_LENGTH);
  const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = combined.slice(SALT_LENGTH + IV_LENGTH);
  const key = await pbkdf2Sha256(utf8ToBytes(passphrase), salt, iterations);

  let secret: string;
  try {
    secret = bytesToUtf8(gcm(key, iv).decrypt(ciphertext));
  } catch {
    throw new Error("That is not the passphrase this wallet was created with. Use the passphrase from the device that made it.");
  }
  if (!/^S[A-Z2-7]{55}$/.test(secret)) throw new Error(BAD_COPY);
  return secret;
}

/**
 * Makes the stored copy for a delegated wallet: the exact format the web app and the server use, so any of
 * them can open it with the passphrase. Used when the user turns the Amma backup on from this phone.
 */
export async function sealBackupSecret(
  secret: string,
  passphrase: string,
  iterations: number = backupConfig.iterations
): Promise<string> {
  if (!/^S[A-Z2-7]{55}$/.test(secret)) throw new Error("Only a Stellar secret key can be backed up.");
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = await pbkdf2Sha256(utf8ToBytes(passphrase), salt, iterations);
  const ciphertext = gcm(key, iv).encrypt(utf8ToBytes(secret));
  const combined = new Uint8Array(SALT_LENGTH + IV_LENGTH + ciphertext.length);
  combined.set(salt, 0);
  combined.set(iv, SALT_LENGTH);
  combined.set(ciphertext, SALT_LENGTH + IV_LENGTH);
  let binary = "";
  for (const byte of combined) binary += String.fromCharCode(byte);
  return btoa(binary);
}
