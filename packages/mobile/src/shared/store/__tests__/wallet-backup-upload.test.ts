import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Device storage fakes ────────────────────────────────────────────────
const secure = new Map<string, string>();
const secureOptions = new Map<string, unknown>();
let bioReadFails = false;
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string, opts?: { requireAuthentication?: boolean }) => {
    if (opts?.requireAuthentication && bioReadFails) throw new Error("Key permanently invalidated");
    return secure.get(k) ?? null;
  }),
  setItemAsync: vi.fn(async (k: string, v: string, opts?: unknown) => {
    secure.set(k, v);
    secureOptions.set(k, opts);
  }),
  deleteItemAsync: vi.fn(async (k: string) => {
    secure.delete(k);
  }),
}));
const asyncStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => asyncStore.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => void asyncStore.set(k, v)),
    removeItem: vi.fn(async (k: string) => void asyncStore.delete(k)),
  },
}));
const bio = { hardware: true, enrolled: true, level: 3 };
vi.mock("expo-local-authentication", () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  hasHardwareAsync: vi.fn(async () => bio.hardware),
  isEnrolledAsync: vi.fn(async () => bio.enrolled),
  getEnrolledLevelAsync: vi.fn(async () => bio.level),
}));
vi.mock("../../lib/api", () => ({ authApi: {} }));

// ── Server fake: one handler per path ───────────────────────────────────
type Reply = { status: number; body: unknown };
const calls: { url: string; method: string; body?: string }[] = [];
let routes: Record<string, Reply | "network-error"> = {};
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, "");
  calls.push({ url: path, method: init?.method ?? "GET", body: init?.body as string | undefined });
  const r = routes[`${init?.method ?? "GET"} ${path}`];
  if (r === "network-error") throw new Error("offline");
  const reply = r ?? { status: 404, body: {} };
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
}));

const { vaultConfig } = await import("../../lib/key-vault");
vaultConfig.iterations = 1000;
const { useWalletStore } = await import("../wallet");
const { useAuthStore } = await import("../auth");

// Public SEP-0005 test vector. Not a real wallet.
const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PASS = "correct horse battery";

const { backupConfig, openBackupSecret } = await import("../../lib/backup-secret");
backupConfig.iterations = 1000;

const patches = () => calls.filter((c) => c.method === "PATCH");

beforeEach(async () => {
  secure.clear(); asyncStore.clear(); calls.length = 0;
  routes = {
    "PATCH /api/v1/wallets/7/activate": { status: 200, body: {} },
    "PATCH /api/v1/wallets/7/secret": { status: 200, body: { ok: true } },
    "PATCH /api/v1/wallets/8/secret": { status: 200, body: { ok: true } },
    "POST /api/v1/wallets": { status: 200, body: { id: 7 } },
  };
  useAuthStore.setState({ accessToken: "token" } as never);
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _vaultKey: null });
  await useWalletStore.getState().setupVault(PASS);
});

describe("turning the Amma backup on from the phone", () => {
  it("sends a passphrase-sealed copy of the active wallet's key that the web app and server can open", async () => {
    const { publicKey, secretKey } = await (async () => {
      const r = await useWalletStore.getState().createWalletFromMnemonic("one", PASS, PHRASE);
      return { publicKey: r.publicKey, secretKey: useWalletStore.getState().getSecretKey()! };
    })();
    calls.length = 0;
    await useWalletStore.getState().uploadKeysForBackup(PASS);
    const sent = patches().filter((c) => c.url.endsWith("/secret"));
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0].body!) as { encryptedSecret: string };
    expect(await openBackupSecret(body.encryptedSecret, PASS)).toBe(secretKey);
    expect(publicKey).toMatch(/^G/);
    // The wallet is made the server's active one first, as the web app does.
    expect(calls.findIndex((c) => c.url.endsWith("/activate"))).toBeLessThan(calls.findIndex((c) => c.url.endsWith("/secret")));
  });

  it("sends nothing for a wrong passphrase", async () => {
    await useWalletStore.getState().createWalletFromMnemonic("one", PASS, PHRASE);
    calls.length = 0;
    await expect(useWalletStore.getState().uploadKeysForBackup("not the passphrase")).rejects.toThrow(/passphrase/i);
    expect(patches()).toHaveLength(0);
  });

  it("says so when this phone has no key for the active wallet, and sends nothing", async () => {
    useWalletStore.setState({
      accounts: [{ id: "s1", serverId: 7, name: "synced", publicKey: `G${"A".repeat(55)}`, encryptedSecret: "secret_none" }],
      activeAccountId: "s1",
    });
    await expect(useWalletStore.getState().uploadKeysForBackup(PASS)).rejects.toThrow(/no key|restore/i);
    expect(patches()).toHaveLength(0);
  });

  it("reports a server failure without claiming success", async () => {
    await useWalletStore.getState().createWalletFromMnemonic("one", PASS, PHRASE);
    routes["PATCH /api/v1/wallets/7/secret"] = { status: 500, body: {} };
    await expect(useWalletStore.getState().uploadKeysForBackup(PASS)).rejects.toThrow(/could not|try again/i);
  });

  it("needs a signed-in user", async () => {
    await useWalletStore.getState().createWalletFromMnemonic("one", PASS, PHRASE);
    useAuthStore.setState({ accessToken: null } as never);
    await expect(useWalletStore.getState().uploadKeysForBackup(PASS)).rejects.toThrow(/sign in/i);
  });

  it("never logs the passphrase or the key", async () => {
    await useWalletStore.getState().createWalletFromMnemonic("one", PASS, PHRASE);
    const logged: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logged.push(a.map(String).join(" ")); });
    routes["PATCH /api/v1/wallets/7/secret"] = { status: 500, body: {} };
    await useWalletStore.getState().uploadKeysForBackup(PASS).catch(() => {});
    expect(logged.join("\n")).not.toContain(PASS);
    expect(logged.join("\n")).not.toMatch(/S[A-Z2-7]{55}/);
    vi.restoreAllMocks();
  });
});
