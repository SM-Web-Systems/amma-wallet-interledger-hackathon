import { useCallback, useEffect, useState } from "react";

/** The most wallets one person can have on one chain. The server enforces the same number; this only mirrors it. */
export const MAX_WALLETS_PER_CHAIN = 10;

/**
 * XRP Ledger base reserve in XRP. The network can change it by validator vote, so screens say "currently". The
 * XRP page's own balance view shows the live figure for a funded wallet.
 */
export const XRP_BASE_RESERVE = "1";

const KEY = "amma.advanced.extraWallets";

/** Extra wallets are an advanced feature and are off unless the person turns them on. Storage failing means off. */
export function readAdvancedWallets(): boolean {
  try { return localStorage.getItem(KEY) === "on"; } catch { return false; }
}

export function writeAdvancedWallets(on: boolean): void {
  try { if (on) localStorage.setItem(KEY, "on"); else localStorage.removeItem(KEY); } catch { /* stays off */ }
  try { window.dispatchEvent(new Event("amma-advanced-wallets")); } catch { /* not in a browser */ }
}

export const walletLimitReached = (count: number): boolean => count >= MAX_WALLETS_PER_CHAIN;

export function useAdvancedWallets(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readAdvancedWallets);
  useEffect(() => {
    const sync = () => setOn(readAdvancedWallets());
    window.addEventListener("amma-advanced-wallets", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("amma-advanced-wallets", sync); window.removeEventListener("storage", sync); };
  }, []);
  return [on, useCallback((next: boolean) => writeAdvancedWallets(next), [])];
}
