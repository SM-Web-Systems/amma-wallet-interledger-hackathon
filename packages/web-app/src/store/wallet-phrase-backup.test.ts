// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";

const api = vi.hoisted(() => ({
  status: vi.fn<() => Promise<{ enabled: boolean; hasPhrase: boolean }>>(),
  savePhrase: vi.fn<(phrase: string) => Promise<{ saved: boolean }>>(),
  getMode: vi.fn<() => Promise<"self" | "delegated">>(),
  add: vi.fn(async () => ({ id: 5 })),
}));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return {
    ...real,
    keyEscrowApi: { status: api.status, savePhrase: api.savePhrase, openPhrase: vi.fn() },
    signingApi: { ...real.signingApi, getMode: api.getMode },
    userWalletApi: { ...real.userWalletApi, add: api.add, list: vi.fn(async () => []) },
  };
});

import { useWalletStore } from "./wallet";

// SEP-0005 test phrase, not a real wallet.
const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  api.status.mockReset().mockResolvedValue({ enabled: true, hasPhrase: false });
  api.savePhrase.mockReset().mockResolvedValue({ saved: true });
  api.getMode.mockReset().mockResolvedValue("delegated");
  api.add.mockClear();
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _mnemonic: null } as never);
});

describe("backing up the recovery phrase with Amma", () => {
  it("saves a new wallet's phrase after it is created, in clean form", async () => {
    await useWalletStore.getState().createWalletFromMnemonic({ name: "one", pin: "a long passphrase 1", mnemonic: `  ${PHRASE.toUpperCase()}  ` });
    expect(api.savePhrase).toHaveBeenCalledTimes(1);
    expect(api.savePhrase).toHaveBeenCalledWith(PHRASE);
  });

  it("saves the phrase of an imported wallet too", async () => {
    await useWalletStore.getState().importFromMnemonic("two", PHRASE, "a long passphrase 1");
    expect(api.savePhrase).toHaveBeenCalledWith(PHRASE);
  });

  it("does nothing for a user who keeps their own keys", async () => {
    api.getMode.mockResolvedValue("self");
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE)).toBe("self-custody");
    expect(api.savePhrase).not.toHaveBeenCalled();
  });

  it("does nothing while the server has the backup switched off", async () => {
    api.status.mockResolvedValue({ enabled: false, hasPhrase: false });
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE)).toBe("off");
    expect(api.savePhrase).not.toHaveBeenCalled();
  });

  it("keeps the wallet and reports failure when the save fails, without logging the phrase", async () => {
    api.savePhrase.mockRejectedValue(new Error("network down"));
    const logged: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logged.push(a.map(String).join(" ")); });
    const created = await useWalletStore.getState().createWalletFromMnemonic({ name: "three", pin: "a long passphrase 1", mnemonic: PHRASE });
    expect(created.publicKey).toMatch(/^G/);
    expect(useWalletStore.getState().accounts).toHaveLength(1);
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE)).toBe("failed");
    expect(logged.join("\n")).not.toContain("illness");
    vi.restoreAllMocks();
  });

  it("never sends an invalid phrase", async () => {
    expect(await useWalletStore.getState().backupRecoveryPhrase("not a phrase")).toBe("failed");
    expect(api.savePhrase).not.toHaveBeenCalled();
  });
});
