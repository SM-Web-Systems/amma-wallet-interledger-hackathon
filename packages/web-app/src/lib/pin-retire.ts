import { decryptSecret } from "./crypto";
import { keypairFromSecret } from "./stellar";
import { loadStellarSecret } from "./stellar-keystore";
import { revealStellarSecret } from "./stellar-device";
import { userWalletApi } from "./api";
import { importDeviceWallet, safeToRemoveLocalCopy } from "./custody-import";
import { isLegacyPin } from "./passphrase";

/**
 * Legacy PIN wallets are retired (audit 2026-11-18, owner decision 2026-11-19). A PIN may open the wallet's key
 * only to move it into the person's Amma account; after that the Amma login password signs. The PIN is never
 * swapped for a passphrase. Where Amma can't hold wallets for the account yet (mainnet off the allow-list),
 * sending waits and receiving carries on. The server answers a PIN signature with code "pin-retired".
 */
export const PIN_RETIRED_CODE = "pin-retired";
export const PIN_RETIRED_MESSAGE = "Short wallet passphrases are no longer used. Move this wallet to your Amma account to send with your login password.";
export const SENDING_PAUSED_MESSAGE = "Short wallet passphrases are no longer used, and Amma can't hold this wallet for your account yet. Sending is paused until it can. You can still receive.";

export { isLegacyPin };

export function isPinRetiredError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === PIN_RETIRED_CODE;
}

/** The import was refused because custody isn't open to this account (mainnet allow-list) or is switched off. */
export function custodyUnavailable(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown } | null;
  if (e?.status === 503) return true;
  return e?.status === 403 && typeof e.message === "string" && /aren't available|not available/i.test(e.message);
}

export interface RetireTarget { publicKey: string; encryptedSecret?: string; isHD?: boolean; serverId?: number }

/** Opens the key with the PIN: this device's copy if it has one, else Amma's stored copy. Throws plain English. */
export async function openWithPin(target: RetireTarget, pin: string): Promise<string> {
  const local = target.encryptedSecret || (await loadStellarSecret(target.publicKey));
  if (local) {
    try { return await revealStellarSecret(target, pin); } catch { throw new Error("That wallet passphrase is not correct."); }
  }
  if (!target.serverId) throw new Error("This wallet isn't linked to your Amma account yet. Sign in again and retry.");
  const copy = (await userWalletApi.getKeyBackup(target.serverId)).encryptedSecret;
  let secret: string;
  try { secret = await decryptSecret(copy, pin); } catch { throw new Error("That wallet passphrase is not correct."); }
  if (keypairFromSecret(secret).publicKey !== target.publicKey) throw new Error("The stored key doesn't match this wallet, so it wasn't moved.");
  return secret;
}

/**
 * Moves the wallet into the Amma account with the login password. "moved" only when the server verified it holds
 * exactly this wallet; "paused" when custody isn't open to the account. The secret is never stored or logged.
 */
export async function moveLegacyPinWallet(o: { address: string; secret: string; password: string; selfCustody: boolean; name?: string }): Promise<"moved" | "paused"> {
  try {
    const result = await importDeviceWallet({ chain: "stellar", address: o.address, secret: o.secret, password: o.password, ...(o.name ? { name: o.name } : {}), ...(o.selfCustody ? { retirePin: true } : {}) });
    if (!safeToRemoveLocalCopy(result, "stellar", o.address)) throw new Error("Amma stored the wallet but couldn't check it yet. Try again in a moment.");
    return "moved";
  } catch (err) {
    if (custodyUnavailable(err)) return "paused";
    throw err;
  }
}
