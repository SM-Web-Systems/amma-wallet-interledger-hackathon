import { request } from "./api";

export const CUSTODY_CHANGED = "amma:custody:changed";

/** How long sign-in waits for Amma wallet setup before carrying on without it (WA-06). */
export const CUSTODY_SETUP_LIMIT_MS = 8000;

/**
 * After sign-in: ask the server to set up Amma-held wallets. The call is idempotent (created or already there);
 * 409 means the user keeps their own keys, 503 means setup is off and 403 means this account is not on the mainnet allow-list; all three leave the app as if custody were off. Never throws.
 * Resolves when setup finishes or after `limitMs`, whichever is first. When wallets were just created, tells the open pages to reload them.
 */
export async function ensureCustodyWallets(limitMs = CUSTODY_SETUP_LIMIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The try stays inside: a request that throws synchronously must not reject this function.
  const setup = (async () => {
    try {
      const res = await request<{ created?: boolean }>("/api/v1/custody/onboard", { method: "POST", body: JSON.stringify({}) });
      if (res?.created && typeof window !== "undefined") window.dispatchEvent(new Event(CUSTODY_CHANGED));
    } catch { /* off, self-custody, or offline: leave the app as it was */ }
  })();
  const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, limitMs); });
  try { await Promise.race([setup, limit]); } finally { clearTimeout(timer); }
}
