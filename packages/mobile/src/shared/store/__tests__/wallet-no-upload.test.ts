// Audit F-1 / TODO D1: the mobile app keeps the Stellar secret key in the
// device's SecureStore and must never send it to the server. It used to post
// the raw "S…" key as `encryptedSecret`.
import { beforeEach, describe, expect, it, vi } from "vitest";

const secure = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(async (k: string, v: string) => void secure.set(k, v)),
  getItemAsync: vi.fn(async (k: string) => secure.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => void secure.delete(k)),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock("expo-local-authentication", () => ({ hasHardwareAsync: vi.fn(async () => false), isEnrolledAsync: vi.fn(async () => false) }));
vi.mock("../auth", () => ({ useAuthStore: { getState: () => ({ accessToken: "token" }) } }));

const bodies: Array<Record<string, unknown>> = [];
globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
  if (init?.method === "POST" && typeof init.body === "string") bodies.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ id: 5 }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

import { useWalletStore } from "../wallet";
import { vaultConfig } from "../../lib/key-vault";
import { isSealed } from "../../lib/vault";

vaultConfig.iterations = 1000; // fast tests; the default cost is checked in vault.test.ts

const SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const SEP5_12 = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const store = () => useWalletStore.getState();

beforeEach(async () => {
  bodies.length = 0;
  secure.clear();
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _vaultKey: null });
  await store().setupVault("correct horse battery"); // D8: keys are only stored while the vault is unlocked
});

describe("mobile wallets: only public metadata goes to the server", () => {
  it.each([
    ["createWallet", () => store().createWallet("A", "12345678")],
    ["importWallet", () => store().importWallet("B", SECRET, "12345678")],
    ["createWalletFromMnemonic", () => store().createWalletFromMnemonic("C", "12345678", SEP5_12)],
    ["importFromMnemonic", () => store().importFromMnemonic("D", SEP5_12, "12345678")],
  ] as const)("%s", async (_name, run) => {
    await run();
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]).sort()).toEqual(["name", "network", "publicKey"]);
    expect(JSON.stringify(bodies)).not.toMatch(/S[A-Z2-7]{55}/);
    // The key is kept on the device, sealed by the passphrase vault (D8), never as plain text.
    const pk = store().accounts[0].publicKey;
    expect(isSealed(secure.get(`secret_${pk}`))).toBe(true);
    expect([...secure.values()].some((v) => /^S[A-Z2-7]{55}$/.test(v))).toBe(false);
  });

  it("sync never writes a server-provided value into SecureStore", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ id: 9, name: "Old", publicKey: "GOLD", isActive: true, encryptedSecret: SECRET }]), { status: 200 }),
    ) as typeof fetch;
    await store().syncFromServer("token");
    expect([...secure.keys()].filter((k) => k !== "vault_key_wrapped")).toEqual([]);
    expect(store().accounts.map((a) => a.publicKey)).toEqual(["GOLD"]);
  });
});
