import { describe, it, expect, vi, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";

const api = vi.hoisted(() => ({
  mode: "self" as "self" | "delegated",
  changeDelegatedPassphrase: vi.fn(async (_c: string, _n: string) => ({ ok: true })),
  updateSecret: vi.fn(async (_id: number, _s: string) => ({ ok: true })),
}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return {
    ...real,
    userWalletApi: { ...real.userWalletApi, changeDelegatedPassphrase: api.changeDelegatedPassphrase, updateSecret: api.updateSecret, list: vi.fn(async () => []) },
    signingApi: { ...real.signingApi, getMode: async () => api.mode },
  };
});
const keystore = vi.hoisted(() => ({ failFor: null as string | null }));
vi.mock("../lib/stellar-keystore", async (orig) => {
  const real = await orig<typeof import("../lib/stellar-keystore")>();
  return {
    ...real,
    saveStellarSecret: async (publicKey: string, encrypted: string) => {
      if (keystore.failFor === publicKey) throw new Error("STORAGE_UNAVAILABLE");
      return real.saveStellarSecret(publicKey, encrypted);
    },
  };
});

import { useWalletStore } from "./wallet";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { loadStellarSecret } from "../lib/stellar-keystore";

const SECRET_A = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const SECRET_B = "SDJHRQF4GCMIIKAAAQ6IHY42X73FQFLHUULAPSKKD4DFDM7UXWWCRHBE";
const OLD = "lamp river garden 42";
const OTHER = "a completely other phrase";
const NEXT = "blue mountain coffee 77";

async function seed() {
  const a = await encryptSecret(SECRET_A, OLD);
  const b = await encryptSecret(SECRET_B, OLD);
  const c = await encryptSecret(SECRET_B, OTHER);
  useWalletStore.setState({
    accounts: [
      { id: "a1", serverId: 1, name: "Main", publicKey: "GA", encryptedSecret: a, createdAt: 1 },
      { id: "a2", serverId: 2, name: "Second", publicKey: "GB", encryptedSecret: b, createdAt: 2 },
      { id: "a3", serverId: 3, name: "Other", publicKey: "GC", encryptedSecret: c, createdAt: 3 },
    ],
    activeAccountId: "a1", isUnlocked: false, _secretKey: null, needsPassphraseUpgrade: false,
  } as never);
  await vi.waitFor(async () => expect(await loadStellarSecret("GC")).toBe(c));
  return { a, b, c };
}

describe("changing the Stellar wallet passphrase", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    api.mode = "self";
    keystore.failFor = null;
    api.changeDelegatedPassphrase.mockClear();
    api.updateSecret.mockClear();
  });

  it("re-encrypts every wallet that opens with the current passphrase and leaves the others alone", async () => {
    const before = await seed();
    await useWalletStore.getState().unlock(OLD);
    expect(await useWalletStore.getState().changePassphrase(OLD, NEXT)).toBe(2);

    const [a, b, c] = useWalletStore.getState().accounts;
    expect(await decryptSecret(a.encryptedSecret, NEXT)).toBe(SECRET_A);
    expect(await decryptSecret(b.encryptedSecret, NEXT)).toBe(SECRET_B);
    await expect(decryptSecret(a.encryptedSecret, OLD)).rejects.toThrow();
    expect(c.encryptedSecret).toBe(before.c);
    expect(await decryptSecret(c.encryptedSecret, OTHER)).toBe(SECRET_B);
  }, 30000);

  it("saves the new copies to the browser key store so a reload keeps them", async () => {
    await seed();
    await useWalletStore.getState().unlock(OLD);
    await useWalletStore.getState().changePassphrase(OLD, NEXT);
    expect(await decryptSecret((await loadStellarSecret("GA"))!, NEXT)).toBe(SECRET_A);
    expect(await decryptSecret((await loadStellarSecret("GB"))!, NEXT)).toBe(SECRET_B);
  }, 30000);

  it("keeps the wallet unlocked and does not use the server in self-custody", async () => {
    await seed();
    await useWalletStore.getState().unlock(OLD);
    await useWalletStore.getState().changePassphrase(OLD, NEXT);
    expect(useWalletStore.getState().isUnlocked).toBe(true);
    expect(useWalletStore.getState().getSecretKey()).toBe(SECRET_A);
    expect(api.changeDelegatedPassphrase).not.toHaveBeenCalled();
    expect(api.updateSecret).not.toHaveBeenCalled();
    useWalletStore.getState().lock();
    await useWalletStore.getState().unlock(NEXT);
    expect(useWalletStore.getState().getSecretKey()).toBe(SECRET_A);
    useWalletStore.getState().lock();
    await expect(useWalletStore.getState().unlock(OLD)).rejects.toThrow();
  }, 30000);

  it("refuses a wrong current passphrase and changes nothing", async () => {
    const before = await seed();
    await expect(useWalletStore.getState().changePassphrase("not the passphrase", NEXT)).rejects.toThrow(/wrong passphrase/i);
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe(before.a);
    expect(useWalletStore.getState().accounts[1].encryptedSecret).toBe(before.b);
  }, 30000);

  it("refuses a weak new passphrase, or the same one, before touching anything", async () => {
    const before = await seed();
    await expect(useWalletStore.getState().changePassphrase(OLD, "short")).rejects.toThrow(/at least 12/i);
    await expect(useWalletStore.getState().changePassphrase(OLD, "123456789012")).rejects.toThrow(/not only numbers/i);
    await expect(useWalletStore.getState().changePassphrase(OLD, OLD)).rejects.toThrow(/different/i);
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe(before.a);
  }, 30000);

  it("delegated signing: the server re-encrypts its copy first, proven by the current passphrase", async () => {
    api.mode = "delegated";
    await seed();
    await useWalletStore.getState().changePassphrase(OLD, NEXT);
    expect(api.changeDelegatedPassphrase).toHaveBeenCalledWith(OLD, NEXT);
    expect(await decryptSecret(useWalletStore.getState().accounts[0].encryptedSecret, NEXT)).toBe(SECRET_A);
  }, 30000);

  it("delegated signing: if the server refuses, nothing changes on this device either", async () => {
    api.mode = "delegated";
    const before = await seed();
    api.changeDelegatedPassphrase.mockRejectedValueOnce(new Error("Invalid PIN"));
    await expect(useWalletStore.getState().changePassphrase(OLD, NEXT)).rejects.toThrow(/invalid pin/i);
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe(before.a);
    expect(await decryptSecret(useWalletStore.getState().accounts[0].encryptedSecret, OLD)).toBe(SECRET_A);
    expect(await loadStellarSecret("GA")).toBe(before.a);
    expect(await loadStellarSecret("GB")).toBe(before.b);
  }, 30000);

  it("puts everything back when the browser key store fails part-way", async () => {
    const before = await seed();
    keystore.failFor = "GB";
    await expect(useWalletStore.getState().changePassphrase(OLD, NEXT)).rejects.toThrow(/nothing was changed/i);
    expect(useWalletStore.getState().accounts[0].encryptedSecret).toBe(before.a);
    expect(useWalletStore.getState().accounts[1].encryptedSecret).toBe(before.b);
    expect(await loadStellarSecret("GA")).toBe(before.a);
    expect(await loadStellarSecret("GB")).toBe(before.b);
  }, 30000);
});
