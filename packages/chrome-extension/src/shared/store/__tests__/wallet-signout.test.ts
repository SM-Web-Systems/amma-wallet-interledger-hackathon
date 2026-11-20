// G-04 / UX-EXTENSION-02: signing out must not destroy a self-custody user's only copy of their key.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  logout: vi.fn(async () => ({})),
  register: vi.fn(async () => ({ accessToken: "t", refreshToken: "r", user: { id: 8 } })),
  me: vi.fn(async () => ({ id: 7 })),
  login: vi.fn(async () => ({ accessToken: "t", refreshToken: "r", user: { id: 8 } })),
  getMode: vi.fn<() => Promise<"self" | "delegated">>(async () => "self"),
}));
vi.mock("../../lib/api", () => ({
  userWalletApi: { list: vi.fn(async () => []), add: vi.fn(), activate: vi.fn(), updateSecret: vi.fn() },
  signingApi: { getMode: api.getMode },
  authApi: { logout: api.logout, register: api.register, me: api.me, login: api.login },
  setTokens: vi.fn(), clearTokens: vi.fn(), getAccessToken: vi.fn(() => "token"),
}));
vi.mock("../../lib/stellar", () => ({ generateKeypair: vi.fn(), keypairFromSecret: vi.fn(), fundTestnet: vi.fn(async () => {}) }));
vi.mock("../../lib/crypto", () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));

import { useWalletStore } from "../wallet";
import { useAuthStore } from "../auth";

const account = { id: "a1", name: "Main", publicKey: "GTESTPUBLICKEY", encryptedSecret: "enc", createdAt: 1 };
const wallet = () => useWalletStore.getState();

beforeEach(() => {
  localStorage.clear();
  useWalletStore.setState({ accounts: [{ ...account }], activeAccountId: "a1", isUnlocked: true, _secretKey: "x", _mnemonic: "y", ownerId: 7 } as never);
  localStorage.setItem("mnemonic_a1", "encrypted-recovery-phrase");
});

describe("wallet logout", () => {
  it("keeps the encrypted accounts and the encrypted recovery phrase, and locks the wallet, when asked to keep keys", () => {
    wallet().logout(true);
    expect(wallet().accounts).toHaveLength(1);
    expect(wallet().accounts[0].encryptedSecret).toBe("enc");
    expect(wallet().isUnlocked).toBe(false);
    expect(() => wallet().getSecretKey()).toThrow();
    expect(localStorage.getItem("mnemonic_a1")).toBe("encrypted-recovery-phrase");
  });

  it("clears the accounts and the local phrase copy when keys are held by Amma (delegated)", () => {
    wallet().logout(false);
    expect(localStorage.getItem("mnemonic_a1")).toBeNull();
    expect(wallet().accounts).toHaveLength(0);
    expect(wallet().activeAccountId).toBeNull();
  });
});

describe("another person signing in on the same browser", () => {
  it("never sees the previous person's local wallets, and those wallets are not deleted", () => {
    wallet().claimFor(8);
    expect(wallet().accounts).toHaveLength(0);
    expect(wallet().ownerId).toBe(8);
    expect(localStorage.getItem("mnemonic_a1")).toBe("encrypted-recovery-phrase");
    expect(wallet().setAside["7"].accounts[0].encryptedSecret).toBe("enc");
  });
  it("the first person gets their wallets back when they sign in again", () => {
    wallet().claimFor(8);
    wallet().claimFor(7);
    expect(wallet().accounts).toHaveLength(1);
    expect(wallet().accounts[0].id).toBe("a1");
    expect(wallet().setAside["7"]).toBeUndefined();
  });
  it("the same person keeps theirs", () => {
    wallet().claimFor(7);
    expect(wallet().accounts).toHaveLength(1);
  });
  it("legacy state with no owner is adopted by the first person to sign in", () => {
    useWalletStore.setState({ ownerId: null } as never);
    wallet().claimFor(9);
    expect(wallet().accounts).toHaveLength(1);
    expect(wallet().ownerId).toBe(9);
  });
});

describe("explicit removal", () => {
  it("removeWalletsFromBrowser is the only action that clears self-custody keys on request", () => {
    wallet().removeWalletsFromBrowser();
    expect(wallet().accounts).toHaveLength(0);
    expect(wallet().ownerId).toBeNull();
  });
});

describe("every way of signing in claims the wallets", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false } as never);
  });
  it("login by a different person sets the first person's wallets aside", async () => {
    await useAuthStore.getState().login("b@example.com", "pw");
    expect(wallet().ownerId).toBe(8);
    expect(wallet().accounts).toHaveLength(0);
  });
  it("register by a different person sets the first person's wallets aside", async () => {
    await useAuthStore.getState().register({} as never);
    expect(wallet().ownerId).toBe(8);
    expect(wallet().accounts).toHaveLength(0);
  });
  it("restoring a session claims wallets from before this update, so they are not adopted by someone else later", async () => {
    useWalletStore.setState({ ownerId: null } as never);
    await useAuthStore.getState().loadProfile();
    expect(wallet().ownerId).toBe(7);
    expect(wallet().accounts).toHaveLength(1);
  });
});

describe("auth logout picks the right mode", () => {
  it("self-custody sign out keeps the keys", async () => {
    useAuthStore.setState({ signingMode: "self", isAuthenticated: true } as never);
    await useAuthStore.getState().logout();
    expect(wallet().accounts).toHaveLength(1);
  });
  it("delegated sign out clears local copies (Amma holds the keys)", async () => {
    useAuthStore.setState({ signingMode: "delegated", isAuthenticated: true } as never);
    await useAuthStore.getState().logout();
    expect(wallet().accounts).toHaveLength(0);
  });
});
