// Audit F-1 / TODO D1: self-custody keys stay on this device.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  add: vi.fn<(body: Record<string, unknown>) => Promise<{ id: number }>>(async () => ({ id: 7 })),
  activate: vi.fn(async () => ({})),
  updateSecret: vi.fn<(id: number, encryptedSecret: string) => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
  getMode: vi.fn<() => Promise<"self" | "delegated">>(async () => "self"),
}));
vi.mock("../../lib/api", () => ({
  userWalletApi: { add: api.add, activate: api.activate, updateSecret: api.updateSecret },
  signingApi: { getMode: api.getMode },
  authApi: {}, setTokens: vi.fn(), clearTokens: vi.fn(), getAccessToken: vi.fn(),
}));
vi.mock("../../lib/stellar", () => ({ generateKeypair: vi.fn(), keypairFromSecret: vi.fn(), fundTestnet: vi.fn(async () => {}) }));
vi.mock("../../lib/crypto", () => ({ encryptSecret: vi.fn(async (s: string) => `enc(${s.length})`), decryptSecret: vi.fn() }));

import { useWalletStore } from "../wallet";

const SEP5_12 = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const store = () => useWalletStore.getState();

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockClear());
  localStorage.clear();
  useWalletStore.setState({ accounts: [], activeAccountId: null, _secretKey: null, _mnemonic: null });
});

describe("extension: self-custody registers only public metadata", () => {
  it.each([
    ["createWalletFromMnemonic", () => store().createWalletFromMnemonic("A", SEP5_12, "12345678")],
    ["importFromMnemonic", () => store().importFromMnemonic("B", SEP5_12, "12345678")],
  ] as const)("%s", async (_name, run) => {
    api.getMode.mockResolvedValue("self");
    await run();
    expect(api.add.mock.calls[0][0]).not.toHaveProperty("encryptedSecret");
    expect(store().accounts[0].encryptedSecret).toBe("enc(56)");
  });

  it("delegated signing still sends the encrypted key", async () => {
    api.getMode.mockResolvedValue("delegated");
    await store().importFromMnemonic("C", SEP5_12, "12345678");
    expect(api.add.mock.calls[0][0].encryptedSecret).toBe("enc(56)");
  });

  it("switching to delegated activates and uploads the active wallet first", async () => {
    useWalletStore.setState({
      accounts: [{ id: "a1", serverId: 3, name: "Main", publicKey: "GPUB", encryptedSecret: "enc(56)", createdAt: 1 }],
      activeAccountId: "a1",
    });
    await store().uploadKeysForDelegatedSigning();
    expect(api.activate).toHaveBeenCalledWith(3);
    expect(api.updateSecret).toHaveBeenCalledWith(3, "enc(56)");
  });

  it("sends nothing when the active wallet has no server id", async () => {
    useWalletStore.setState({
      accounts: [{ id: "a1", name: "Main", publicKey: "GPUB", encryptedSecret: "enc(56)", createdAt: 1 }],
      activeAccountId: "a1",
    });
    await expect(store().uploadKeysForDelegatedSigning()).rejects.toThrow(/not registered/i);
    expect(api.updateSecret).not.toHaveBeenCalled();
  });
});
