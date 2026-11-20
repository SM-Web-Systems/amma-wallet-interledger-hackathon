import { useCallback, useEffect, useState } from "react";
import { CUSTODY_CHANGED } from "./custody-onboard";
import { addCustodyWallet, listCustodyWallets, makeCustodyWalletMain, renameCustodyWallet, type CustodyChain, type CustodyWallet } from "./custody-wallets";

/** Loads the user's Amma-held wallets for one chain. status "off" means show the page as it was before. */
export function useCustodyWallets(chain: CustodyChain) {
  const [status, setStatus] = useState<"loading" | "on" | "off">("loading");
  const [wallets, setWallets] = useState<CustodyWallet[]>([]);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);

  const reload = useCallback(async () => {
    const all = await listCustodyWallets();
    setWallets(all.filter((w) => w.chain === chain)); setStatus("on");
  }, [chain]);
  useEffect(() => {
    let live = true;
    listCustodyWallets().then((all) => { if (live) { setWallets(all.filter((w) => w.chain === chain)); setStatus("on"); } }).catch(() => { if (live) setStatus("off"); });
    const again = () => { listCustodyWallets().then((all) => { if (live) { setWallets(all.filter((w) => w.chain === chain)); setStatus("on"); } }).catch(() => undefined); };
    window.addEventListener(CUSTODY_CHANGED, again);
    return () => { live = false; window.removeEventListener(CUSTODY_CHANGED, again); };
  }, [chain]);

  const act = useCallback(async (work: () => Promise<unknown>) => {
    setWorking(true); setMessage("");
    try { await work(); await reload(); } catch (cause) { setMessage(cause instanceof Error && cause.message ? cause.message : "That did not work. Try again."); } finally { setWorking(false); }
  }, [reload]);

  return {
    status, wallets, message, working,
    add: () => act(() => addCustodyWallet(chain)),
    makeMain: (address: string) => act(() => makeCustodyWalletMain(chain, address)),
    rename: (address: string, name: string) => act(() => renameCustodyWallet(chain, address, name)),
  };
}

export const shortAddress = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
