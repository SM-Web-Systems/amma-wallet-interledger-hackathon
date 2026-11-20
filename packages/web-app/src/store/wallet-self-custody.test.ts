// @vitest-environment node
// Audit F-1 / TODO D1 (owner decision 2026-11-11): in self-custody mode the
// encrypted Stellar key stays on this device and is never sent to the server.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  add: vi.fn<(body: Record<string, unknown>) => Promise<{ id: number }>>(async () => ({ id: 77 })),
  list: vi.fn(async () => [] as Array<{ id: number; publicKey: string }>),
  updateSecret: vi.fn<(id: number, encryptedSecret: string) => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
  activate: vi.fn(async () => ({})),
  getMode: vi.fn<() => Promise<"self" | "delegated">>(async () => { throw new Error("offline"); }),
}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  const { getMode, ...wallet } = api;
  return { ...real, userWalletApi: { ...real.userWalletApi, ...wallet }, signingApi: { ...real.signingApi, getMode } };
});
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock("../lib/stellar-keystore", () => ({
  saveStellarSecret: vi.fn(async (pk: string, enc: string) => { disk.set(pk, enc); }),
  loadStellarSecret: vi.fn(async (pk: string) => disk.get(pk) ?? null),
  loadAllStellarSecrets: vi.fn(async () => new Map(disk)),
  deleteStellarSecret: vi.fn(async (pk: string) => { disk.delete(pk); }),
}));
vi.mock("../lib/stellar", async (orig) => ({ ...(await orig<typeof import("../lib/stellar")>()), fundTestnet: vi.fn(async () => {}) }));

import { useWalletStore } from "./wallet";
import { useAuthStore } from "./auth";
import { encryptSecret } from "../lib/crypto";

const PASS = "lamp river garden 42";
const SEP5_12 = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";

const store = () => useWalletStore.getState();
const sentBodies = () => api.add.mock.calls.map(([body]) => body);

beforeEach(() => {
  disk.clear();
  Object.values(api).forEach((fn) => fn.mockClear());
  api.getMode.mockImplementation(async () => { throw new Error("offline"); });
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _mnemonic: null, needsPassphraseUpgrade: false } as never);
});

describe("self-custody: no key material is uploaded", () => {
  beforeEach(() => useAuthStore.setState({ signingMode: "self" }));

  const creators: Array<[string, () => Promise<unknown>]> = [
    ["createWallet", async () => { await store().createWallet("A", PASS); await store().confirmBackup(store().accounts[0].id); }],
    ["importWallet", () => store().importWallet("B", SECRET, PASS)],
    ["createWalletFromMnemonic", () => store().createWalletFromMnemonic({ name: "C", pin: PASS, mnemonic: SEP5_12 })],
    ["importFromMnemonic", () => store().importFromMnemonic("D", SEP5_12, PASS)],
  ];

  it.each(creators)("%s registers only public metadata", async (_name, run) => {
    await run();
    expect(api.add).toHaveBeenCalledTimes(1);
    const body = sentBodies()[0];
    expect(Object.keys(body).sort()).toEqual(["name", "network", "publicKey"]);
    expect(JSON.stringify(body)).not.toMatch(/"S[A-Z2-7]{55}"/);
    // The key is still kept (encrypted) on this device.
    expect(store().accounts[0].encryptedSecret).toBeTruthy();
    expect(store().accounts[0].serverId).toBe(77);
  }, 20000);
});

describe("delegated signing still keeps a server copy", () => {
  beforeEach(() => useAuthStore.setState({ signingMode: "delegated" }));

  it("createWallet sends the encrypted key", async () => {
    await store().createWallet("E", PASS);
    await store().confirmBackup(store().accounts[0].id);
    expect(typeof sentBodies()[0].encryptedSecret).toBe("string");
    expect(sentBodies()[0].encryptedSecret).toBe(store().accounts[0].encryptedSecret);
  }, 20000);
});

describe("the server's signing mode wins over a stale local value", () => {
  it("uploads when the server says delegated although this tab still says self", async () => {
    useAuthStore.setState({ signingMode: "self" });
    api.getMode.mockResolvedValue("delegated");
    await store().importFromMnemonic("F", SEP5_12, PASS);
    expect(typeof sentBodies()[0].encryptedSecret).toBe("string");
  }, 20000);

  it("does not upload when the server says self although this tab says delegated", async () => {
    useAuthStore.setState({ signingMode: "delegated" });
    api.getMode.mockResolvedValue("self");
    await store().createWalletFromMnemonic({ name: "G", pin: PASS, mnemonic: SEP5_12 });
    expect(sentBodies()[0]).not.toHaveProperty("encryptedSecret");
  }, 20000);
});

describe("switching to delegated signing uploads this device's encrypted keys", () => {
  beforeEach(() => useAuthStore.setState({ signingMode: "self" }));

  it("sends each local ciphertext that has a server id", async () => {
    const enc = await encryptSecret(SECRET, PASS);
    useWalletStore.setState({
      accounts: [
        { id: "a1", serverId: 9, name: "Main", publicKey: "GPUB", encryptedSecret: enc, createdAt: 1 },
        { id: "a2", name: "No server id", publicKey: "GOTHER", encryptedSecret: enc, createdAt: 2 },
      ],
      activeAccountId: "a1",
    } as never);
    await store().uploadKeysForDelegatedSigning();
    expect(api.activate).toHaveBeenCalledWith(9);
    expect(api.updateSecret).toHaveBeenCalledTimes(1);
    expect(api.updateSecret).toHaveBeenCalledWith(9, enc);
  }, 20000);

  it("refuses when this device has no key for the active wallet", async () => {
    useWalletStore.setState({
      accounts: [{ id: "a1", serverId: 9, name: "Main", publicKey: "GPUB", encryptedSecret: "", createdAt: 1 }],
      activeAccountId: "a1",
    } as never);
    await expect(store().uploadKeysForDelegatedSigning()).rejects.toThrow(/no copy/i);
    expect(api.updateSecret).not.toHaveBeenCalled();
  });

  it("sends nothing when the active wallet has no server id", async () => {
    const enc = await encryptSecret(SECRET, PASS);
    useWalletStore.setState({
      accounts: [
        { id: "a1", name: "Local only", publicKey: "GPUB", encryptedSecret: enc, createdAt: 1 },
        { id: "a2", serverId: 4, name: "Other", publicKey: "GOTHER", encryptedSecret: enc, createdAt: 2 },
      ],
      activeAccountId: "a1",
    } as never);
    await expect(store().uploadKeysForDelegatedSigning()).rejects.toThrow(/not registered/i);
    expect(api.updateSecret).not.toHaveBeenCalled();
  });
});
