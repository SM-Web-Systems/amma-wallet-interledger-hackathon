import { passphraseProblem } from "./decrypt-secret";
import { custodyAllowedForUser, type CustodyFlags } from "./custody-flags";

/**
 * Legacy 6+ character PIN wallets are retired (audit 2026-11-18, owner decision 2026-11-19):
 * a PIN may unlock the stored copy only to move the wallet into Amma custody, never to sign,
 * and it may not be swapped for a passphrase. Where custody isn't available to the account
 * (mainnet users off CUSTODY_MAINNET_USER_IDS) sending waits until it is; receiving is unaffected.
 */
export const PIN_RETIRED_CODE = "pin-retired";
export const PIN_RETIRED_MOVE = "Wallet PINs are no longer used. Move this wallet to your Amma account, then send with your login password.";
export const PIN_RETIRED_PAUSED = "Wallet PINs are no longer used. Sending from this wallet is paused until Amma can hold it for your account. You can still receive.";

/** True for a secret set under the old PIN rule (anything that fails the 12+ character passphrase rule). */
export const isLegacyPin = (secret: string): boolean => passphraseProblem(secret) !== null;

export function pinRetired(flags: Pick<CustodyFlags, "serverSigning" | "mainnet" | "mainnetUserIds">, userId: number) {
  const custodyAvailable = flags.serverSigning === true && custodyAllowedForUser(flags, userId);
  return { error: custodyAvailable ? PIN_RETIRED_MOVE : PIN_RETIRED_PAUSED, code: PIN_RETIRED_CODE, custodyAvailable };
}

/** Response schema for a 403 that may carry the pin-retired fields (Fastify drops undeclared properties). */
export const FORBIDDEN_SCHEMA = { type: "object", properties: { error: { type: "string" }, code: { type: "string" }, custodyAvailable: { type: "boolean" } } } as const;
