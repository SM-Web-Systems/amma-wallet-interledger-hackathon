// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";

const api = vi.hoisted(() => ({
  getMode: vi.fn<() => Promise<"self" | "delegated">>(),
  updateSecret: vi.fn<(id: number, enc: string) => Promise<{ ok: boolean }>>(),
  add: vi.fn(async () => ({ id: 9 })),
}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return {
    ...real,
    keyEscrowApi: { status: vi.fn(async () => ({ enabled: false, hasPhrase: false })), savePhrase: vi.fn(), openPhrase: vi.fn() },
    signingApi: { ...real.signingApi, getMode: api.getMode },
    userWalletApi: { ...real.userWalletApi, updateSecret: api.updateSecret, add: api.add, list: vi.fn(async () => []) },
  };
});

import { useWalletStore } from "./wallet";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { loadStellarSecret } from "../lib/stellar-keystore";
import { deriveHDKeypair } from "../lib/hd-wallet";

// SEP-0005 test phrase, not a real wallet.
const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const FORGOTTEN = "the passphrase nobody remembers";
const NEW = "a brand new passphrase 42";
const k0 = deriveHDKeypair(PHRASE, 0);
const k1 = deriveHDKeypair(PHRASE, 1);

async function localWallets(indexes: number[]) {
  const accounts = [];
  for (const i of indexes) {
    const k = deriveHDKeypair(PHRASE, i);
    accounts.push({ id: `a${i}`, serverId: 10 + i, name: `w${i}`, publicKey: k.publicKey, encryptedSecret: await encryptSecret(k.secretKey, FORGOTTEN), createdAt: 1, isHD: true, derivationIndex: i });
  }
  useWalletStore.setState({ accounts, activeAccountId: accounts[0].id, isUnlocked: false, _secretKey: null, _mnemonic: null } as never);
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  api.getMode.mockReset().mockResolvedValue("delegated");
  api.updateSecret.mockReset().mockResolvedValue({ ok: true });
  api.add.mockClear();
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _mnemonic: null } as never);
});

describe("choosing a new passphrase with a recovered phrase", () => {
  it("re-encrypts every local wallet of that phrase under the new passphrase, saves it and unlocks", async () => {
    await localWallets([0, 1]);
    const res = await useWalletStore.getState().resetPassphraseFromPhrase(PHRASE, NEW);
    expect(res).toEqual({ updated: 2, serverSynced: true });
    const s = useWalletStore.getState();
    expect(await decryptSecret(s.accounts[0].encryptedSecret, NEW)).toBe(k0.secretKey);
    expect(await decryptSecret(s.accounts[1].encryptedSecret, NEW)).toBe(k1.secretKey);
    await expect(decryptSecret(s.accounts[0].encryptedSecret, FORGOTTEN)).rejects.toThrow();
    expect(await decryptSecret((await loadStellarSecret(k0.publicKey))!, NEW)).toBe(k0.secretKey);
    expect(s.isUnlocked).toBe(true);
    expect(s.getSecretKey()).toBe(k0.secretKey);
    expect(api.add).not.toHaveBeenCalled();
  });

  it("replaces the server's copy too, for a managed wallet", async () => {
    await localWallets([0]);
    await useWalletStore.getState().resetPassphraseFromPhrase(PHRASE, NEW);
    expect(api.updateSecret).toHaveBeenCalledTimes(1);
    const [id, enc] = api.updateSecret.mock.calls[0];
    expect(id).toBe(10);
    expect(await decryptSecret(enc, NEW)).toBe(k0.secretKey);
  });

  it("leaves the server alone for a self-custody wallet", async () => {
    api.getMode.mockResolvedValue("self");
    await localWallets([0]);
    expect(await useWalletStore.getState().resetPassphraseFromPhrase(PHRASE, NEW)).toEqual({ updated: 1, serverSynced: true });
    expect(api.updateSecret).not.toHaveBeenCalled();
  });

  it("still finishes on this device when the server copy cannot be replaced, and says so", async () => {
    api.updateSecret.mockRejectedValue(new Error("offline"));
    await localWallets([0]);
    expect(await useWalletStore.getState().resetPassphraseFromPhrase(PHRASE, NEW)).toEqual({ updated: 1, serverSynced: false });
    expect(await decryptSecret(useWalletStore.getState().accounts[0].encryptedSecret, NEW)).toBe(k0.secretKey);
  });

  it("adds the wallet when this device has none of that phrase's wallets", async () => {
    const res = await useWalletStore.getState().resetPassphraseFromPhrase(PHRASE, NEW);
    expect(res.updated).toBe(1);
    expect(api.add).toHaveBeenCalledTimes(1);
    const s = useWalletStore.getState();
    expect(s.accounts[0].publicKey).toBe(k0.publicKey);
    expect(await decryptSecret(s.accounts[0].encryptedSecret, NEW)).toBe(k0.secretKey);
    expect(s.isUnlocked).toBe(true);
  });

  it("ignores wallets that belong to another phrase", async () => {
    await localWallets([0]);
    const other = deriveHDKeypair("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", 0);
    const mine = useWalletStore.getState().accounts[0];
    const otherEnc = await encryptSecret(other.secretKey, FORGOTTEN);
    useWalletStore.setState({ accounts: [mine, { ...mine, id: "z", serverId: 99, publicKey: other.publicKey, encryptedSecret: otherEnc }] } as never);
    await useWalletStore.getState().resetPassphraseFromPhrase(PHRASE, NEW);
    expect(useWalletStore.getState().accounts[1].encryptedSecret).toBe(otherEnc);
  });

  it("refuses a weak passphrase or a bad phrase before changing anything", async () => {
    await localWallets([0]);
    const before = useWalletStore.getState().accounts[0].encryptedSecret;
    await expect(useWalletStore.getState().resetPassphraseFromPhrase(PHRASE, "short")).rejects.toThrow(/at least/i);
    await expect(useWalletStore.getState().resetPassphraseFromPhrase("not a real phrase", NEW)).rejects.toThrow(/recovery phrase/i);
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe(before);
    expect(api.updateSecret).not.toHaveBeenCalled();
  });
});
