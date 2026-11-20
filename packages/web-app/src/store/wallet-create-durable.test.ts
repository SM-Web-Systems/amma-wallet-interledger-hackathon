// @vitest-environment node
// H2: a new device wallet is only created once its encrypted key is really stored in this browser.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  add: vi.fn(async (_b: Record<string, unknown>) => ({ id: 77 })),
  list: vi.fn(async () => []),
  getMode: vi.fn<() => Promise<"self" | "delegated">>(async () => "self"),
}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  const { getMode, ...wallet } = api;
  return { ...real, userWalletApi: { ...real.userWalletApi, ...wallet }, signingApi: { ...real.signingApi, getMode } };
});
const keystore = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  failWrite: false,
  dropWrite: false,
}));
vi.mock("../lib/stellar-keystore", () => ({
  saveStellarSecret: vi.fn(async (pk: string, enc: string) => {
    if (keystore.failWrite) throw new Error("STORAGE_UNAVAILABLE");
    if (!keystore.dropWrite) keystore.disk.set(pk, enc);
  }),
  loadStellarSecret: vi.fn(async (pk: string) => keystore.disk.get(pk) ?? null),
  loadAllStellarSecrets: vi.fn(async () => new Map(keystore.disk)),
  deleteStellarSecret: vi.fn(async (pk: string) => { keystore.disk.delete(pk); }),
}));
vi.mock("../lib/stellar", async (orig) => ({ ...(await orig<typeof import("../lib/stellar")>()), fundTestnet: vi.fn(async () => {}) }));

import { useWalletStore } from "./wallet";

const PASS = "lamp river garden 42";
const SEP5_12 = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const store = () => useWalletStore.getState();
const persist = vi.fn<() => Promise<boolean>>();

beforeEach(() => {
  keystore.disk.clear(); keystore.failWrite = false; keystore.dropWrite = false;
  api.add.mockClear();
  persist.mockReset(); persist.mockResolvedValue(true);
  vi.stubGlobal("navigator", { ...globalThis.navigator, storage: { persist } });
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _mnemonic: null, storagePersisted: null } as never);
});

const creators: Array<[string, () => Promise<unknown>]> = [
  ["createWallet", () => store().createWallet("W", PASS)],
  ["importWallet", () => store().importWallet("W", SECRET, PASS)],
  ["createWalletFromMnemonic", () => store().createWalletFromMnemonic({ name: "W", pin: PASS, mnemonic: SEP5_12 })],
  ["importFromMnemonic", () => store().importFromMnemonic("W", SEP5_12, PASS)],
];

describe("a server name clash leaves no orphan key behind", () => {
  it.each([
    ["createWalletFromMnemonic", () => store().createWalletFromMnemonic({ name: "W", pin: PASS, mnemonic: SEP5_12 })],
  ])("%s", async (_n, run) => {
    api.add.mockRejectedValueOnce(new Error("A wallet with this name already exists"));
    await expect(run()).rejects.toThrow(/already exists/i);
    expect(keystore.disk.size).toBe(0);
    expect(store().accounts).toEqual([]);
  });
});

describe("storagePersisted is remembered", () => {
  it("is part of the persisted state", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./wallet.ts", import.meta.url), "utf-8");
    expect(src).toContain("storagePersisted: state.storagePersisted");
  });
});

describe.each(creators)("%s is durable", (_name, run) => {
  it("rejects, adds no wallet and registers nothing when the browser write fails", async () => {
    keystore.failWrite = true;
    await expect(run()).rejects.toThrow(/could not be saved in this browser/i);
    expect(store().accounts).toEqual([]);
    expect(store()._secretKey).toBeNull();
    expect(api.add).not.toHaveBeenCalled();
  });

  it("rejects when the write seems to succeed but the key cannot be read back", async () => {
    keystore.dropWrite = true;
    await expect(run()).rejects.toThrow(/could not be saved in this browser/i);
    expect(store().accounts).toEqual([]);
  });

  it("succeeds when the key reads back and opens, and stores it in the browser", async () => {
    await run();
    expect(store().accounts).toHaveLength(1);
    expect(keystore.disk.get(store().accounts[0].publicKey)).toBe(store().accounts[0].encryptedSecret);
  });

  it("asks the browser for persistent storage once and records the answer", async () => {
    await run();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(store().storagePersisted).toBe(true);
  });
});

describe("persistent storage refused", () => {
  it("does not block creation, and records that the browser may clear the key", async () => {
    persist.mockResolvedValue(false);
    await store().createWallet("W", PASS);
    expect(store().accounts).toHaveLength(1);
    expect(store().storagePersisted).toBe(false);
  });

  it("copes with browsers that have no storage.persist", async () => {
    vi.stubGlobal("navigator", { ...globalThis.navigator, storage: undefined });
    await store().createWallet("W", PASS);
    expect(store().accounts).toHaveLength(1);
    expect(store().storagePersisted).toBeNull();
  });

  it("copes with persist() throwing", async () => {
    persist.mockRejectedValue(new Error("nope"));
    await store().createWallet("W", PASS);
    expect(store().accounts).toHaveLength(1);
    expect(store().storagePersisted).toBe(false);
  });
});

describe("a new random-key wallet needs its backup confirmed", () => {
  it("is marked backupPending on creation, and only that path", async () => {
    await store().createWallet("Rand", PASS);
    await store().importWallet("Imp", SECRET, PASS);
    const [rand, imp] = store().accounts;
    expect(rand.backupPending).toBe(true);
    expect(imp.backupPending).toBeUndefined();
  });

  it("confirmBackup clears it", async () => {
    await store().createWallet("Rand", PASS);
    await store().confirmBackup(store().accounts[0].id);
    expect(store().accounts[0].backupPending).toBeUndefined();
  });

  it("is not registered with the server until the backup is confirmed (so no claim or payment can reach it first)", async () => {
    await store().createWallet("Rand", PASS);
    expect(api.add).not.toHaveBeenCalled();
    expect(store().accounts[0].serverId).toBeUndefined();
    await store().confirmBackup(store().accounts[0].id);
    expect(api.add).toHaveBeenCalledTimes(1);
    expect(api.add.mock.calls[0][0]).toMatchObject({ name: "Rand", publicKey: store().accounts[0].publicKey });
    expect(store().accounts[0].serverId).toBe(77);
  });

  it("an unreachable server does not trap the person behind the backup step", async () => {
    await store().createWallet("Rand", PASS);
    api.add.mockRejectedValueOnce(new Error("offline"));
    await store().confirmBackup(store().accounts[0].id);
    expect(store().accounts[0].backupPending).toBeUndefined();
  });

  it("wallets stored before this change are not gated", () => {
    useWalletStore.setState({ accounts: [{ id: "old", name: "Old", publicKey: "GOLD", encryptedSecret: "x", createdAt: 1 }], activeAccountId: "old" } as never);
    expect(store().accounts.some((a) => a.backupPending)).toBe(false);
  });
});
