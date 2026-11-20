import crypto from "crypto";

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const ITERATIONS = 600_000;

export async function decryptSecret(encrypted: string, pin: string): Promise<string> {
  if (!encrypted || encrypted.length < 60) {
    throw new Error("Encrypted data too short or missing");
  }

  const combined = Buffer.from(encrypted, "base64");
  if (combined.length < SALT_LENGTH + IV_LENGTH + 17) {
    throw new Error("Encrypted data too short or corrupted");
  }

  const salt = combined.subarray(0, SALT_LENGTH);
  const iv = combined.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const ciphertext = combined.subarray(SALT_LENGTH + IV_LENGTH);

  // Derive key using PBKDF2 (same params as frontend)
  const key = crypto.pbkdf2Sync(pin, salt, ITERATIONS, 32, "sha256");

  // Decrypt using AES-256-GCM
  const authTagLength = 16;
  const encryptedData = ciphertext.subarray(0, ciphertext.length - authTagLength);
  const authTag = ciphertext.subarray(ciphertext.length - authTagLength);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

/** Same format as the web app's encryptSecret: base64(salt 16 + iv 12 + AES-256-GCM ciphertext + tag). */
export async function encryptSecret(secret: string, passphrase: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([salt, iv, encrypted, cipher.getAuthTag()]).toString("base64");
}

/** Wallet passphrase rule shared with the web app: 12-128 characters, not digits only. */
export function passphraseProblem(passphrase: string): string | null {
  if (!passphrase || passphrase.trim().length < 12) return "Use at least 12 characters.";
  if (passphrase.length > 128) return "Use at most 128 characters.";
  if (/^\d+$/.test(passphrase)) return "Use words or letters, not only numbers.";
  return null;
}
