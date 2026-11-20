// H1: the Stellar wallet list on this browser belongs to one signed-in user.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

const api = vi.hoisted(() => ({
  list: vi.fn<() => Promise<Array<Record<string, unknown>>>>(async () => []),
  updateSecret: vi.fn(async () => ({ ok: true })),
  activate: vi.fn(async () => ({})),
  getMode: vi.fn(async () => "self" as const),
  me: vi.fn<() => Promise<Record<string, unknown>>>(),
  token: { v: "tok" as string | null },
}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  const { getMode, me, token: _t, ...wallet } = api;
  return {
    ...real,
    getAccessToken: () => api.token.v,
    restoreSession: async () => false,
    userWalletApi: { ...real.userWalletApi, ...wallet },
    signingApi: { ...real.signingApi, getMode },
    authApi: { ...real.authApi, me },
  };
});
vi.mock("../lib/custody-onboard", () => ({ ensureCustodyWallets: vi.fn(async () => {}) }));

import { useWalletStore } from "./wallet";
import { useAuthStore } from "./auth";
import { saveStellarSecret, loadStellarSecret, setStellarKeystoreOwner } from "../lib/stellar-keystore";

const A = { id: "a1", serverId: 11, name: "A main", publicKey: "GAAA", encryptedSecret: "enc-A", createdAt: 1 };
const sw = (id: number, publicKey: string, isActive = true) => ({ id, name: "w", publicKey, network: "testnet", isActive, createdAt: "2026-01-01T00:00:00Z" });
const store = () => useWalletStore.getState();

async function seedUser1Device(opts: { owner: number | null }) {
  setStellarKeystoreOwner(opts.owner);
  await saveStellarSecret("GAAA", "enc-A");
  useWalletStore.setState({ accounts: [A], activeAccountId: "a1", ownerId: opts.owner, setAside: {}, isUnlocked: false, _secretKey: null } as never);
}

beforeEach(() => {
  setStellarKeystoreOwner(null);
  vi.stubGlobal("indexedDB", new IDBFactory());
  localStorage.clear();
  api.token.v = "tok";
  [api.list, api.updateSecret, api.activate, api.getMode, api.me].forEach((f) => f.mockReset());
  api.getMode.mockResolvedValue("self");
  api.list.mockResolvedValue([]);
  api.updateSecret.mockResolvedValue({ ok: true });
  api.activate.mockResolvedValue({});
});

describe("wallets are bound to the signed-in user", () => {
  it("a second user does not inherit the first user's wallets or active wallet", async () => {
    await seedUser1Device({ owner: 1 });
    api.list.mockResolvedValue([sw(22, "GBBB")]);
    store().claimFor(2, ["GBBB"]);
    await store().syncFromServer();
    const s = store();
    expect(s.accounts.map((a) => a.publicKey)).toEqual(["GBBB"]);
    expect(s.accounts.find((a) => a.id === s.activeAccountId)?.publicKey).toBe("GBBB");
  });

  it("never uploads the first user's key under the second user's session", async () => {
    await seedUser1Device({ owner: 1 });
    api.list.mockResolvedValue([sw(22, "GBBB")]);
    store().claimFor(2, ["GBBB"]);
    await store().syncFromServer();
    await store().uploadKeysForDelegatedSigning().catch(() => {});
    expect(api.updateSecret).not.toHaveBeenCalledWith(11, expect.anything());
  });

  it("gives the first user their wallet and key back when they sign in again", async () => {
    await seedUser1Device({ owner: 1 });
    store().claimFor(2, ["GBBB"]);
    store().claimFor(1, ["GAAA"]);
    expect(store().accounts.map((a) => a.publicKey)).toEqual(["GAAA"]);
    expect(store().activeAccountId).toBe("a1");
    await vi.waitFor(() => expect(store().accounts[0].encryptedSecret).toBe("enc-A"));
    expect(await loadStellarSecret("GAAA")).toBe("enc-A");
  });

  it("locks and clears the secret when the owner changes", async () => {
    await seedUser1Device({ owner: 1 });
    useWalletStore.setState({ isUnlocked: true, _secretKey: "SECRET", _mnemonic: "words" } as never);
    store().claimFor(2, []);
    expect(store().isUnlocked).toBe(false);
    expect(store()._secretKey).toBeNull();
    expect(store()._mnemonic).toBeNull();
  });

  it("keeps the owner's wallets when the same user signs in again", async () => {
    await seedUser1Device({ owner: 1 });
    store().claimFor(1, ["GAAA"]);
    expect(store().accounts).toHaveLength(1);
    expect(store().ownerId).toBe(1);
  });

  it("persists the owner and never persists keys for set-aside wallets", async () => {
    await seedUser1Device({ owner: 1 });
    store().claimFor(2, []);
    const saved = JSON.parse(localStorage.getItem("amma-wallet")!);
    expect(saved.state.ownerId).toBe(2);
    expect(JSON.stringify(saved)).not.toContain("enc-A");
    expect(saved.state.setAside["1"].accounts[0].publicKey).toBe("GAAA");
  });
});

describe("migration: wallets saved before owner binding", () => {
  it("are claimed by the first user whose server wallet list contains them", async () => {
    await seedUser1Device({ owner: null });
    store().claimFor(1, ["GAAA"]);
    expect(store().ownerId).toBe(1);
    expect(store().accounts.map((a) => a.publicKey)).toEqual(["GAAA"]);
    expect(store().activeAccountId).toBe("a1");
  });

  it("are hidden from a user whose server list does not contain them, and kept for the real owner", async () => {
    await seedUser1Device({ owner: null });
    store().claimFor(2, ["GBBB"]);
    expect(store().accounts).toEqual([]);
    expect(store().activeAccountId).toBeNull();
    store().claimFor(1, ["GAAA"]);
    expect(store().accounts.map((a) => a.publicKey)).toEqual(["GAAA"]);
    expect(store().activeAccountId).toBe("a1");
    await vi.waitFor(async () => expect(await loadStellarSecret("GAAA")).toBe("enc-A"));
  });

  it("only the matching legacy wallets are claimed", async () => {
    await seedUser1Device({ owner: null });
    useWalletStore.setState((s) => ({ accounts: [...s.accounts, { ...A, id: "a2", publicKey: "GCCC", serverId: 33 }] }));
    store().claimFor(1, ["GAAA"]);
    expect(store().accounts.map((a) => a.publicKey)).toEqual(["GAAA"]);
  });
});

describe("auth wiring", () => {
  it("loadProfile claims the wallets for the signed-in user before syncing", async () => {
    await seedUser1Device({ owner: 1 });
    useAuthStore.setState({ isAuthenticated: true } as never);
    api.me.mockResolvedValue({ user: { id: 2, email: "b@x" }, wallets: [sw(22, "GBBB")] });
    api.list.mockResolvedValue([sw(22, "GBBB")]);
    await useAuthStore.getState().loadProfile();
    expect(store().ownerId).toBe(2);
    expect(store().accounts.map((a) => a.publicKey)).toEqual(["GBBB"]);
  });

  it("locks the wallet when the session is gone", async () => {
    await seedUser1Device({ owner: 1 });
    useWalletStore.setState({ isUnlocked: true, _secretKey: "SECRET" } as never);
    api.token.v = null;
    useAuthStore.setState({ isAuthenticated: false } as never);
    await useAuthStore.getState().loadProfile();
    expect(store()._secretKey).toBeNull();
    expect(store().isUnlocked).toBe(false);
  });
});

describe("H1-a: no frame shows the previous owner's wallet to the new user", () => {
  it("login binds the wallet list before the new user counts as signed in", async () => {
    await seedUser1Device({ owner: 1 });
    api.token.v = "tok";
    const seen: string[][] = [];
    useAuthStore.setState({ user: null, isAuthenticated: false, serverWallets: [] } as never);
    const watch = (): void => { if (useAuthStore.getState().isAuthenticated) seen.push(store().accounts.map((a) => a.publicKey)); };
    const offA = useAuthStore.subscribe(watch);
    const offW = useWalletStore.subscribe(watch);
    const real = await import("../lib/api");
    vi.spyOn(real.authApi, "login").mockResolvedValue({ user: { id: 2, email: "b@x" }, accessToken: "a", refreshToken: "r" } as never);
    api.list.mockResolvedValue([sw(22, "GBBB")]);
    await useAuthStore.getState().login("b@x", "pw");
    offA(); offW();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.flat()).not.toContain("GAAA");
  });
});

describe("H1-b: a listed public key does not reach another owner's stored key", () => {
  it("stored keys are filed under the owner", async () => {
    await seedUser1Device({ owner: null });
    store().claimFor(1, ["GAAA"]);
    await vi.waitFor(async () => expect(await loadStellarSecret("GAAA")).toBe("enc-A"));
    store().claimFor(2, ["GAAA"]); // user 2 lists user 1's address on the server
    expect(await loadStellarSecret("GAAA")).toBeNull();
    expect(store().accounts.every((a) => a.encryptedSecret === "")).toBe(true);
  });

  it("legacy unprefixed records of claimed wallets move under the new owner", async () => {
    await seedUser1Device({ owner: null });
    store().claimFor(1, ["GAAA"]);
    await vi.waitFor(async () => expect(await loadStellarSecret("GAAA")).toBe("enc-A"));
    await vi.waitFor(() => expect(store().accounts[0].encryptedSecret).toBe("enc-A"));
  });
});

describe("H1-c: another tab changing the owner locks this one", () => {
  it("re-reads the stored owner on a storage event and locks if it changed", async () => {
    await seedUser1Device({ owner: 1 });
    useWalletStore.setState({ isUnlocked: true, _secretKey: "SECRET" } as never);
    localStorage.setItem("amma-wallet", JSON.stringify({ state: { accounts: [], activeAccountId: null, ownerId: 2, setAside: {} }, version: 0 }));
    window.dispatchEvent(new StorageEvent("storage", { key: "amma-wallet" }));
    await vi.waitFor(() => expect(store().ownerId).toBe(2));
    expect(store()._secretKey).toBeNull();
    expect(store().isUnlocked).toBe(false);
    expect(store().accounts).toEqual([]);
  });

  it("does nothing when the owner is unchanged", async () => {
    await seedUser1Device({ owner: 1 });
    useWalletStore.setState({ isUnlocked: true, _secretKey: "SECRET" } as never);
    localStorage.setItem("amma-wallet", JSON.stringify({ state: { accounts: [], activeAccountId: null, ownerId: 1, setAside: {} }, version: 0 }));
    window.dispatchEvent(new StorageEvent("storage", { key: "amma-wallet" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(store()._secretKey).toBe("SECRET");
  });
});
