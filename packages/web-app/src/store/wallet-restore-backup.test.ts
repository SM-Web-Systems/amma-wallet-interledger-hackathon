// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";

const api = vi.hoisted(() => ({
  getKeyBackup: vi.fn<(id: number) => Promise<{ encryptedSecret: string }>>(),
}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return { ...real, userWalletApi: { ...real.userWalletApi, getKeyBackup: api.getKeyBackup, list: vi.fn(async () => []) } };
});

import { useWalletStore } from "./wallet";
import { encryptSecret } from "../lib/crypto";
import { loadStellarSecret } from "../lib/stellar-keystore";
import { keypairFromSecret } from "../lib/stellar";

// Public test secret, not a real wallet.
const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const MADE_WITH = "phone passphrase here 1";

async function noKeyHere(publicKey: string) {
  useWalletStore.setState({
    accounts: [{ id: "a1", serverId: 7, name: "wallet", publicKey, encryptedSecret: "", createdAt: 1 }],
    activeAccountId: "a1", isUnlocked: false, _secretKey: null, needsPassphraseUpgrade: false,
  } as never);
}

describe("restoring this browser's key from the Amma backup", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    api.getKeyBackup.mockReset();
  });

  it("opens the stored copy with the passphrase it was made with, keeps it in this browser's key store and unlocks", async () => {
    const publicKey = keypairFromSecret(SECRET).publicKey;
    const copy = await encryptSecret(SECRET, MADE_WITH);
    api.getKeyBackup.mockResolvedValue({ encryptedSecret: copy });
    await noKeyHere(publicKey);

    await useWalletStore.getState().restoreFromServerBackup(MADE_WITH);

    expect(api.getKeyBackup).toHaveBeenCalledWith(7);
    const s = useWalletStore.getState();
    expect(s.accounts[0].encryptedSecret).toBe(copy);
    expect(s.isUnlocked).toBe(true);
    expect(s.getSecretKey()).toBe(SECRET);
    expect(await loadStellarSecret(publicKey)).toBe(copy);
  });

  it("says so for a different passphrase and keeps nothing", async () => {
    const publicKey = keypairFromSecret(SECRET).publicKey;
    api.getKeyBackup.mockResolvedValue({ encryptedSecret: await encryptSecret(SECRET, MADE_WITH) });
    await noKeyHere(publicKey);

    await expect(useWalletStore.getState().restoreFromServerBackup("another passphrase")).rejects.toThrow(/passphrase/i);
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe("");
    expect(await loadStellarSecret(publicKey)).toBeNull();
  });

  it("refuses a copy whose key is for a different address", async () => {
    api.getKeyBackup.mockResolvedValue({ encryptedSecret: await encryptSecret(SECRET, MADE_WITH) });
    await noKeyHere(`G${"B".repeat(55)}`);

    await expect(useWalletStore.getState().restoreFromServerBackup(MADE_WITH)).rejects.toThrow(/does not match/i);
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe("");
  });

  it("explains when Amma has no copy", async () => {
    api.getKeyBackup.mockRejectedValue(new Error("No stored key for this wallet"));
    await noKeyHere(keypairFromSecret(SECRET).publicKey);
    await expect(useWalletStore.getState().restoreFromServerBackup(MADE_WITH)).rejects.toThrow(/no stored key|no backup/i);
  });

  it("does nothing when this browser already has the key", async () => {
    const publicKey = keypairFromSecret(SECRET).publicKey;
    const copy = await encryptSecret(SECRET, MADE_WITH);
    useWalletStore.setState({
      accounts: [{ id: "a1", serverId: 7, name: "wallet", publicKey, encryptedSecret: copy, createdAt: 1 }],
      activeAccountId: "a1", isUnlocked: false, _secretKey: null, needsPassphraseUpgrade: false,
    } as never);
    await expect(useWalletStore.getState().restoreFromServerBackup(MADE_WITH)).rejects.toThrow(/already/i);
    expect(api.getKeyBackup).not.toHaveBeenCalled();
  });
});
