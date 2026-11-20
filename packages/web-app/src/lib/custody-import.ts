import { request } from "./api";
import { CUSTODY_CHANGED } from "./custody-onboard";

export type ImportChain = "stellar" | "xrpl" | "evm";

export interface ImportResult {
  alreadyHeld: boolean;
  imported: boolean;
  /** The server signed a test message with the stored key and it checked out. Only then may the device copy go. */
  verified: boolean;
  wallet?: { chain?: string; address?: string };
}

/**
 * Sends a device-only wallet's secret to Amma over the signed-in API, with the account password, so Amma can hold it.
 * The server checks that the secret really controls the address before it stores anything. Never log the arguments.
 * Rejects with the server's plain-English message.
 */
export async function importDeviceWallet(input: { chain: ImportChain; address: string; secret: string; password: string; name?: string; /** Legacy PIN wallet of a self-custody account: the move switches the account to Amma-managed signing. */ retirePin?: true }): Promise<ImportResult> {
  const res = await request<{ wallet?: { chain?: string; address?: string }; imported?: boolean; alreadyHeld?: boolean; verified?: boolean }>(
    "/api/v1/custody/import", { method: "POST", body: JSON.stringify(input) });
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CUSTODY_CHANGED));
  return { alreadyHeld: res?.alreadyHeld === true, imported: res?.imported === true, verified: res?.verified === true, wallet: res?.wallet };
}

/** True only when the response proves Amma holds exactly this wallet and its key was verified. */
export function safeToRemoveLocalCopy(result: ImportResult, chain: ImportChain, address: string): boolean {
  if (!result.verified || !(result.imported || result.alreadyHeld)) return false;
  const w = result.wallet;
  if (!w || w.chain !== chain || typeof w.address !== "string") return false;
  return chain === "evm" ? w.address.toLowerCase() === address.toLowerCase() : w.address === address;
}
