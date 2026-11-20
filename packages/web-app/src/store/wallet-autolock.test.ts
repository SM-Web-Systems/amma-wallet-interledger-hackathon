// H3: a decrypted Stellar secret does not stay in memory for the whole session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/stellar-keystore", () => ({
  saveStellarSecret: vi.fn(async () => {}), loadStellarSecret: vi.fn(async () => null),
  loadAllStellarSecrets: vi.fn(async () => new Map()), deleteStellarSecret: vi.fn(async () => {}),
}));

import { useWalletStore } from "./wallet";
import { encryptSecret } from "../lib/crypto";
import { startStellarAutoLock, IDLE_LOCK_MS, HIDDEN_GRACE_MS } from "../lib/stellar-autolock";

const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const PASS = "lamp river garden 42";
const store = () => useWalletStore.getState();
let stop: (() => void) | undefined;
let hidden = false;

async function unlockedWallet() {
  const encryptedSecret = await encryptSecret(SECRET, PASS);
  useWalletStore.setState({
    accounts: [{ id: "a1", name: "Main", publicKey: "GAAA", encryptedSecret, createdAt: 1 }],
    activeAccountId: "a1", isUnlocked: true, _secretKey: SECRET, _mnemonic: "some words",
  } as never);
}
const setHidden = (value: boolean) => { hidden = value; document.dispatchEvent(new Event("visibilitychange")); };

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _mnemonic: null } as never);
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

describe("idle lock", () => {
  it("clears the secret and the phrase after 5 minutes without activity", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    vi.advanceTimersByTime(IDLE_LOCK_MS - 1);
    expect(store().isUnlocked).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store().isUnlocked).toBe(false);
    expect(store()._secretKey).toBeNull();
    expect(store()._mnemonic).toBeNull();
    expect(() => store().getSecretKey()).toThrow(/locked/i);
  });

  it("is 5 minutes, the same as the XRP wallet", () => {
    expect(IDLE_LOCK_MS).toBe(5 * 60_000);
  });

  it("activity restarts the countdown", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    vi.advanceTimersByTime(IDLE_LOCK_MS - 1000);
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(IDLE_LOCK_MS - 1000);
    expect(store().isUnlocked).toBe(true);
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(IDLE_LOCK_MS);
    expect(store().isUnlocked).toBe(false);
  });

  it("starts counting when the wallet is unlocked after the lock was started", async () => {
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    expect(vi.getTimerCount()).toBe(0);
    useWalletStore.setState({ isUnlocked: true, _secretKey: SECRET } as never);
    vi.advanceTimersByTime(IDLE_LOCK_MS);
    expect(store().isUnlocked).toBe(false);
  });
});

describe("hidden tab", () => {
  it("locks after a short grace, not at once", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    setHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1);
    expect(store().isUnlocked).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store().isUnlocked).toBe(false);
    expect(store()._secretKey).toBeNull();
  });

  it("keeps the wallet open when the person comes back within the grace", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    setHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1000);
    setHidden(false);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    expect(store().isUnlocked).toBe(true);
  });

  it("locks on return if the idle time ran out while the tab was throttled", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    vi.setSystemTime(Date.now() + IDLE_LOCK_MS + 1000);
    setHidden(false);
    expect(store().isUnlocked).toBe(false);
  });
});

describe("other tab", () => {
  it("locks when the session changes in another tab", async () => {
    await unlockedWallet();
    stop = startStellarAutoLock();
    window.dispatchEvent(new StorageEvent("storage", { key: "amma-wallet-auth" }));
    expect(store().isUnlocked).toBe(false);
    expect(store()._secretKey).toBeNull();
  });

  it("ignores unrelated storage keys", async () => {
    await unlockedWallet();
    stop = startStellarAutoLock();
    window.dispatchEvent(new StorageEvent("storage", { key: "amma-wallet-theme" }));
    expect(store().isUnlocked).toBe(true);
  });
});

describe("after a lock", () => {
  it("needs the passphrase again, and the wallet itself is untouched", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    vi.advanceTimersByTime(IDLE_LOCK_MS);
    expect(store().accounts).toHaveLength(1);
    vi.useRealTimers();
    await expect(store().unlock("wrong passphrase!!")).rejects.toThrow();
    expect(store().isUnlocked).toBe(false);
    await store().unlock(PASS);
    expect(store().getSecretKey()).toBe(SECRET);
  });

  it("arms no timers for a wallet that is not unlocked (Amma-held wallets have no device secret)", () => {
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    expect(vi.getTimerCount()).toBe(0);
    setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops listening when stopped", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    startStellarAutoLock()();
    vi.advanceTimersByTime(IDLE_LOCK_MS * 2);
    expect(store().isUnlocked).toBe(true);
  });
});

describe("H3 review fixes", () => {
  it("locks on return when the hidden time passed the grace even though frozen timers never fired", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    window.dispatchEvent(new Event("pointerdown")); // fresh activity, so only the hidden time can lock
    setHidden(true);
    vi.setSystemTime(Date.now() + HIDDEN_GRACE_MS + 1); // no timer callbacks run, as on a frozen iOS tab
    setHidden(false);
    expect(store().isUnlocked).toBe(false);
  });

  it("does not lock on return within the grace", async () => {
    await unlockedWallet();
    vi.useFakeTimers();
    stop = startStellarAutoLock();
    setHidden(true);
    vi.setSystemTime(Date.now() + HIDDEN_GRACE_MS - 1000);
    setHidden(false);
    expect(store().isUnlocked).toBe(true);
  });

  it("locks when a session ends (clearTokens)", async () => {
    const { clearTokens } = await import("../lib/api");
    await unlockedWallet();
    stop = startStellarAutoLock();
    clearTokens();
    expect(store().isUnlocked).toBe(false);
    expect(store()._secretKey).toBeNull();
  });

  it("locks when another tab clears all storage (event key null)", async () => {
    await unlockedWallet();
    stop = startStellarAutoLock();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(store().isUnlocked).toBe(false);
  });
});
