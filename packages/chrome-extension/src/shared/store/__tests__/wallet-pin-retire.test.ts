// Retired short wallet passphrases (PINs): they never unlock for signing; they may only move the wallet into the Amma account.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const kp = Keypair.random();
const m = vi.hoisted(() => ({
  importWallet: vi.fn(),
  getMode: vi.fn<() => Promise<"self" | "delegated">>(async () => "self"),
}));
vi.mock("../../lib/api", () => ({
  userWalletApi: {}, signingApi: { getMode: m.getMode }, custodyApi: { importWallet: m.importWallet },
  authApi: {}, setTokens: vi.fn(), clearTokens: vi.fn(), getAccessToken: vi.fn(),
}));
// "enc:<passphrase>:<secret>" stands in for real encryption; the passphrase must match to open it.
vi.mock("../../lib/crypto", () => ({
  encryptSecret: vi.fn(async (s: string, p: string) => `enc:${p}:${s}`),
  decryptSecret: vi.fn(async (e: string, p: string) => { const [, pass, ...rest] = e.split(":"); if (pass !== p) throw new Error("bad"); return rest.join(":"); }),
}));

import { useWalletStore } from "../wallet";
import { useAuthStore } from "../auth";

const store = () => useWalletStore.getState();
const seed = (pass: string) => useWalletStore.setState({
  accounts: [{ id: "a1", name: "Main", publicKey: kp.publicKey(), encryptedSecret: `enc:${pass}:${kp.secret()}`, createdAt: 1 } as never],
  activeAccountId: "a1", isUnlocked: false, _secretKey: null, _mnemonic: null, pinRetired: false,
});
const verified = { imported: true, verified: true, wallet: { chain: "stellar", address: kp.publicKey() } };

beforeEach(() => {
  m.importWallet.mockReset();
  localStorage.clear();
  useAuthStore.setState({ signingMode: "self" } as never);
});

describe("extension: retired short wallet passphrases", () => {
  it("a correct old PIN does not unlock and opens the move dialog", async () => {
    seed("123456");
    await expect(store().unlock("123456")).rejects.toMatchObject({ code: "pin-retired" });
    expect(store().isUnlocked).toBe(false);
    expect(store()._secretKey).toBeNull();
    expect(store().pinRetired).toBe(true);
  });

  it("a strong passphrase unlocks as before", async () => {
    seed("lamp river garden 42");
    await store().unlock("lamp river garden 42");
    expect(store().isUnlocked).toBe(true);
    expect(store().pinRetired).toBe(false);
  });

  it("moves the wallet with the login password, removes this device's copy, and the account becomes managed", async () => {
    seed("123456");
    m.importWallet.mockResolvedValue(verified);
    expect(await store().retireLegacyPin("123456", "login pw")).toBe("moved");
    expect(m.importWallet).toHaveBeenCalledWith({ chain: "stellar", address: kp.publicKey(), secret: kp.secret(), password: "login pw", name: "Main", retirePin: true });
    expect(store().accounts[0].encryptedSecret).toBe("");
    expect(useAuthStore.getState().signingMode).toBe("delegated");
    await expect(store().unlock("123456")).rejects.toThrow(/Amma holds this wallet/);
  });

  it("keeps this device's copy when the server didn't verify the move", async () => {
    seed("123456");
    m.importWallet.mockResolvedValue({ ...verified, verified: false });
    await expect(store().retireLegacyPin("123456", "login pw")).rejects.toThrow(/couldn't check/);
    expect(store().accounts[0].encryptedSecret).toContain("enc:");
  });

  it("says sending is paused where Amma can't hold the wallet yet, and keeps the copy", async () => {
    seed("123456");
    m.importWallet.mockRejectedValue(new Error("Amma-held wallets aren't available for this account on mainnet yet."));
    expect(await store().retireLegacyPin("123456", "login pw")).toBe("paused");
    expect(store().accounts[0].encryptedSecret).toContain("enc:");
    expect(useAuthStore.getState().signingMode).toBe("self");
  });

  it("a wrong old passphrase moves nothing", async () => {
    seed("123456");
    await expect(store().retireLegacyPin("654321", "login pw")).rejects.toThrow(/not correct/);
    expect(m.importWallet).not.toHaveBeenCalled();
  });
});
