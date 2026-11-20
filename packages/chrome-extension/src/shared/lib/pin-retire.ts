import { keypairFromSecret } from "./stellar";
import { custodyApi } from "./api";
import { isLegacyPin } from "./passphrase";

/**
 * Legacy short wallet passphrases (PINs) are retired (audit 2026-11-18, owner decision 2026-11-19). A correct one
 * never unlocks the wallet for signing; it may only move the wallet into the person's Amma account, after which
 * the Amma login password signs. Where Amma can't hold wallets for the account yet, sending is paused.
 */
export const PIN_RETIRED_CODE = "pin-retired";
export const PIN_RETIRED_MESSAGE = "Short wallet passphrases are no longer used. Move this wallet to your Amma account to keep sending.";
export const SENDING_PAUSED_MESSAGE = "Short wallet passphrases are no longer used, and Amma can't hold this wallet for your account yet. Sending is paused until it can. You can still receive.";
export const AMMA_HELD_MESSAGE = "Amma holds this wallet for your account. Use your Amma login password to approve it.";
export const MOVED_MESSAGE = "Done. Amma now holds this wallet for your account. Use your Amma login password to send from now on.";

/** Amma holds this wallet's key (moved, or never on this device): the login password approves, the server signs. */
export function isAmmaHeld(account: { encryptedSecret?: string } | null | undefined): boolean {
  return !!account && !account.encryptedSecret;
}

export { isLegacyPin };

export function isPinRetiredError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === PIN_RETIRED_CODE;
}

/** Custody switched off, or not open to this account on mainnet (the server's wording). */
export function custodyUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return /aren't available|not switched on/i.test(msg);
}

/**
 * Moves the wallet with the login password. "moved" only when the server verified it holds exactly this wallet;
 * "paused" when custody isn't open to the account. The secret is never stored or logged.
 */
export async function moveLegacyPinWallet(o: { address: string; secret: string; password: string; selfCustody: boolean; name?: string }): Promise<"moved" | "paused"> {
  if (o.secret.startsWith("S") && keypairFromSecret(o.secret).publicKey !== o.address) throw new Error("This device's key doesn't match this wallet, so it wasn't moved.");
  try {
    const r = await custodyApi.importWallet({ chain: "stellar", address: o.address, secret: o.secret, password: o.password, ...(o.name ? { name: o.name } : {}), ...(o.selfCustody ? { retirePin: true } : {}) });
    if (r?.verified !== true || !(r.imported || r.alreadyHeld) || r.wallet?.chain !== "stellar" || r.wallet?.address !== o.address) {
      throw new Error("Amma stored the wallet but couldn't check it yet. Try again in a moment.");
    }
    return "moved";
  } catch (err) {
    if (custodyUnavailable(err)) return "paused";
    throw err;
  }
}
