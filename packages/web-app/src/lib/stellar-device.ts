import { decryptSecret } from "./crypto";
import { keypairFromSecret } from "./stellar";
import { loadStellarSecret } from "./stellar-keystore";
import { deriveHDKeypair } from "./hd-wallet";

/**
 * For "Move to Amma" only: what to upload for this device's Stellar wallet, after the device passphrase opens it.
 * The recovery phrase (SEP-5 index 0) when the device has one for this exact wallet, otherwise the S... secret.
 * Use once, then drop it.
 */
export async function revealStellarSecret(account: { publicKey: string; encryptedSecret?: string; isHD?: boolean }, passphrase: string): Promise<string> {
  const { publicKey } = account;
  const encrypted = account.encryptedSecret || (await loadStellarSecret(publicKey)) || "";
  if (!encrypted) throw new Error("This browser has no copy of this wallet's key.");
  let secret: string;
  try { secret = await decryptSecret(encrypted, passphrase); } catch { throw new Error("The passphrase is incorrect."); }
  if (keypairFromSecret(secret).publicKey !== publicKey) throw new Error("This device copy cannot be verified.");
  const sealed = account.isHD ? localStorage.getItem(`mnemonic_${publicKey}`) : null;
  if (sealed) {
    try {
      const phrase = await decryptSecret(sealed, passphrase);
      if (deriveHDKeypair(phrase, 0).publicKey === publicKey) return phrase;
    } catch { /* no usable phrase: the secret key below is just as good */ }
  }
  return secret;
}
