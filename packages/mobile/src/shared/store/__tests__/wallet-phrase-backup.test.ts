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

const ON: Record<string, Reply> = {
  "GET /api/v1/key-escrow/status": { status: 200, body: { enabled: true, hasPhrase: false } },
  "GET /api/v1/user/signing-mode": { status: 200, body: { signingMode: "delegated" } },
  "PUT /api/v1/key-escrow/phrase": { status: 200, body: { saved: true } },
  "POST /api/v1/wallets": { status: 200, body: { id: 3 } },
};
const saves = () => calls.filter((c) => c.method === "PUT" && c.url === "/api/v1/key-escrow/phrase");

beforeEach(async () => {
  secure.clear(); asyncStore.clear(); calls.length = 0; routes = { ...ON };
  useAuthStore.setState({ accessToken: "token" } as never);
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _vaultKey: null });
  await useWalletStore.getState().setupVault(PASS);
});

describe("backing up the recovery phrase with Amma (phone)", () => {
  it("saves the phrase for a delegated user when the server offers it", async () => {
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE.toUpperCase())).toBe("saved");
    expect(saves()).toHaveLength(1);
    expect(JSON.parse(saves()[0].body!)).toEqual({ phrase: PHRASE });
  });

  it("does it when a wallet is created from a phrase, and when one is imported", async () => {
    await useWalletStore.getState().createWalletFromMnemonic("one", PASS, PHRASE);
    expect(saves()).toHaveLength(1);
    useWalletStore.setState({ accounts: [], activeAccountId: null });
    calls.length = 0;
    await useWalletStore.getState().importFromMnemonic("two", PHRASE, PASS);
    expect(saves()).toHaveLength(1);
  });

  it("does nothing while the server has the backup switched off", async () => {
    routes["GET /api/v1/key-escrow/status"] = { status: 200, body: { enabled: false, hasPhrase: false } };
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE)).toBe("off");
    expect(saves()).toHaveLength(0);
  });

  it("does nothing for a user who keeps their own keys", async () => {
    routes["GET /api/v1/user/signing-mode"] = { status: 200, body: { signingMode: "self" } };
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE)).toBe("self-custody");
    expect(saves()).toHaveLength(0);
  });

  it("reports failure, keeps the wallet, and never logs the phrase when the server or network fails", async () => {
    const logged: string[] = [];
    for (const m of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logged.push(a.map(String).join(" ")); });
    routes["PUT /api/v1/key-escrow/phrase"] = { status: 500, body: { error: "boom" } };
    const created = await useWalletStore.getState().createWalletFromMnemonic("three", PASS, PHRASE);
    expect(created.publicKey).toMatch(/^G/);
    expect(useWalletStore.getState().accounts).toHaveLength(1);
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE)).toBe("failed");
    routes["PUT /api/v1/key-escrow/phrase"] = "network-error";
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE)).toBe("failed");
    expect(logged.join("\n")).not.toContain("illness");
    vi.restoreAllMocks();
  });

  it("never sends something that is not a valid phrase, and needs a signed-in user", async () => {
    expect(await useWalletStore.getState().backupRecoveryPhrase("not a phrase")).toBe("failed");
    useAuthStore.setState({ accessToken: null } as never);
    expect(await useWalletStore.getState().backupRecoveryPhrase(PHRASE)).toBe("failed");
    expect(saves()).toHaveLength(0);
  });
});
