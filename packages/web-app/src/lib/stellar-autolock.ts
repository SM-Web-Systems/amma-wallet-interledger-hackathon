import { useWalletStore } from "../store/wallet";

/** Dispatched by clearTokens() when a session ends (sign-out, failed refresh). */
const SESSION_END_EVENT = "amma:xrpl:lock";

/** Same idle limit as the XRP wallet page. */
export const IDLE_LOCK_MS = 5 * 60_000;
/** A hidden tab keeps the wallet open this long, so a quick look at another tab does not ask for the passphrase. */
export const HIDDEN_GRACE_MS = 30_000;

/**
 * Locks the device Stellar wallet (drops the decrypted secret key and phrase from the store) after
 * 5 minutes without activity, a short grace after the tab is hidden, and when the session changes in another tab.
 * Nothing runs while the wallet is locked, so Amma-held wallets, which have no device secret, are unaffected.
 * Returns a function that stops it.
 */
export function startStellarAutoLock(): () => void {
  let idle: ReturnType<typeof setTimeout> | undefined;
  let hide: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = Date.now();
  let hiddenAt: number | null = null; // timers are frozen in some hidden tabs (iOS), so also compare clocks on return
  const unlocked = () => useWalletStore.getState().isUnlocked;
  const clear = () => { clearTimeout(idle); clearTimeout(hide); idle = hide = undefined; };

  const lock = () => {
    clear();
    useWalletStore.getState().lock();
  };
  const arm = () => {
    clearTimeout(idle); idle = undefined;
    if (unlocked()) idle = setTimeout(lock, IDLE_LOCK_MS);
  };
  const activity = () => { lastActivity = Date.now(); arm(); };
  const visibility = () => {
    clearTimeout(hide); hide = undefined;
    if (!unlocked()) { hiddenAt = null; return; }
    if (document.hidden) {
      hiddenAt = Date.now();
      hide = setTimeout(lock, HIDDEN_GRACE_MS);
      return;
    }
    const was = hiddenAt;
    hiddenAt = null;
    if ((was !== null && Date.now() - was >= HIDDEN_GRACE_MS) || Date.now() - lastActivity >= IDLE_LOCK_MS) lock();
  };
  // key === null: another tab cleared all storage.
  const storage = (event: StorageEvent) => { if (event.key === "amma-wallet-auth" || event.key === null) lock(); };

  const events = ["pointerdown", "keydown", "touchstart"] as const;
  events.forEach((name) => window.addEventListener(name, activity));
  window.addEventListener("storage", storage);
  window.addEventListener(SESSION_END_EVENT, lock);
  document.addEventListener("visibilitychange", visibility);
  const unsubscribe = useWalletStore.subscribe((state, prev) => {
    if (state.isUnlocked === prev.isUnlocked) return;
    lastActivity = Date.now();
    if (state.isUnlocked) arm();
    else clear();
  });
  arm();

  return () => {
    clear();
    events.forEach((name) => window.removeEventListener(name, activity));
    window.removeEventListener("storage", storage);
    window.removeEventListener(SESSION_END_EVENT, lock);
    document.removeEventListener("visibilitychange", visibility);
    unsubscribe();
  };
}
