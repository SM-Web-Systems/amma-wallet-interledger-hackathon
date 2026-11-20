import { describe, it, expect, vi, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";

vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, userWalletApi: { ...real.userWalletApi, remove: vi.fn(async () => ({})), list: vi.fn(async () => []), updateSecret: vi.fn(async () => ({ ok: true })) } };
});

import { useWalletStore } from "./wallet";
import { encryptSecret } from "../lib/crypto";
import { loadStellarSecret } from "../lib/stellar-keystore";

const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const PASS = "lamp river garden 42";

async function addAccount(publicKey = "GPUB") {
  const encryptedSecret = await encryptSecret(SECRET, PASS);
  useWalletStore.setState({
    accounts: [{ id: "a1", name: "Main", publicKey, encryptedSecret, createdAt: 1 }],
    activeAccountId: "a1", isUnlocked: false, _secretKey: null,
  } as never);
  await vi.waitFor(async () => expect(await loadStellarSecret(publicKey)).toBe(encryptedSecret));
  return encryptedSecret;
}

/** What a page reload leaves: accounts from localStorage, which never hold the secret. */
async function reload() {
  const saved = localStorage.getItem("amma-wallet");
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null } as never, false);
  if (saved) localStorage.setItem("amma-wallet", saved);
  await useWalletStore.persist.rehydrate();
  expect(useWalletStore.getState().accounts[0]?.publicKey).toBe("GPUB");
}

describe("self-custody Stellar wallets survive a page reload", () => {
  beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); localStorage.clear(); });

  it("keeps the encrypted key in IndexedDB, never in localStorage", async () => {
    const encrypted = await addAccount();
    expect(localStorage.getItem("amma-wallet") ?? "").not.toContain(encrypted);
  });

  it("restores the encrypted key after a reload so unlock works", async () => {
    const encrypted = await addAccount();
    await reload();
    await vi.waitFor(() => expect(useWalletStore.getState().accounts[0]?.encryptedSecret).toBe(encrypted));
    await useWalletStore.getState().unlock(PASS);
    expect(useWalletStore.getState().getSecretKey()).toBe(SECRET);
  });

  it("unlock reads the key store when the account in memory has no key yet", async () => {
    await addAccount();
    useWalletStore.setState((s) => ({ accounts: s.accounts.map((a) => ({ ...a, encryptedSecret: "" })) }));
    await useWalletStore.getState().unlock(PASS);
    expect(useWalletStore.getState().isUnlocked).toBe(true);
  });

  it("gives a clear message when this browser has no copy of the key", async () => {
    useWalletStore.setState({ accounts: [{ id: "a1", name: "Main", publicKey: "GNONE", encryptedSecret: "", createdAt: 1 }], activeAccountId: "a1" } as never);
    await expect(useWalletStore.getState().unlock(PASS)).rejects.toThrow(/restore it with your recovery phrase or secret key/i);
  });

  it("forgets the key when the wallet is removed", async () => {
    await addAccount();
    useWalletStore.getState().removeAccount("a1");
    await vi.waitFor(async () => expect(await loadStellarSecret("GPUB")).toBeNull());
  });
});
