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
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

const { vaultConfig } = await import("../../lib/key-vault");
vaultConfig.iterations = 1000; // keep tests fast; the default cost is checked in vault.test.ts
const { useWalletStore } = await import("../wallet");
const { isSealed } = await import("../../lib/vault");

// Public SEP-0005 test vector (12 words, account 0). Not a real wallet.
const PHRASE = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
const PASS = "correct horse battery";
const LEGACY_SECRET = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
const LEGACY_PUBLIC = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

function reset() {
  secure.clear();
  secureOptions.clear();
  asyncStore.clear();
  bioReadFails = false;
  bio.hardware = true;
  bio.enrolled = true;
  bio.level = 3;
  useWalletStore.setState({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _vaultKey: null });
}

describe("mobile wallet vault (D8)", () => {
  beforeEach(reset);

  it("refuses a weak passphrase", async () => {
    await expect(useWalletStore.getState().setupVault("123456")).rejects.toThrow(/12 characters/);
  });

  it("stores keys and recovery phrases encrypted, never as plain text", async () => {
    await useWalletStore.getState().setupVault(PASS);
    const { publicKey } = await useWalletStore.getState().createWalletFromMnemonic("Main", "", PHRASE, 0);
    const stored = [...secure.entries()].filter(([k]) => k.includes(publicKey));
    expect(stored.length).toBe(2);
    for (const [, v] of stored) {
      expect(isSealed(v)).toBe(true);
      expect(v).not.toMatch(/^S[A-Z2-7]{55}$/);
      expect(v).not.toContain("illness");
    }
  });

  it("needs the right passphrase to unlock after locking", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await useWalletStore.getState().importWallet("Old", LEGACY_SECRET, "");
    useWalletStore.getState().lock();
    expect(useWalletStore.getState().getSecretKey()).toBeNull();

    await expect(useWalletStore.getState().unlock("wrong passphrase here")).rejects.toThrow(/wrong passphrase/i);
    expect(useWalletStore.getState().getSecretKey()).toBeNull();

    await useWalletStore.getState().unlock(PASS);
    expect(useWalletStore.getState().getSecretKey()).toBe(LEGACY_SECRET);
  });

  it("will not add a wallet while the vault is locked", async () => {
    await useWalletStore.getState().setupVault(PASS);
    useWalletStore.getState().lock();
    await expect(useWalletStore.getState().importWallet("X", LEGACY_SECRET, "")).rejects.toThrow(/unlock/i);
    expect([...secure.keys()].some((k) => k.includes(LEGACY_PUBLIC))).toBe(false);
  });

  it("migrates plain-text keys from older installs and removes the plain copies", async () => {
    secure.set(`secret_${LEGACY_PUBLIC}`, LEGACY_SECRET);
    secure.set(`mnemonic_${LEGACY_PUBLIC}`, PHRASE);
    useWalletStore.setState({
      accounts: [{ id: "a1", name: "Old", publicKey: LEGACY_PUBLIC, encryptedSecret: `secret_${LEGACY_PUBLIC}` }],
      activeAccountId: "a1",
    });
    expect(await useWalletStore.getState().needsVaultSetup()).toBe(true);

    await useWalletStore.getState().setupVault(PASS);

    for (const v of secure.values()) {
      expect(v).not.toBe(LEGACY_SECRET);
      expect(v).not.toBe(PHRASE);
    }
    expect(isSealed(secure.get(`secret_${LEGACY_PUBLIC}`))).toBe(true);
    useWalletStore.getState().lock();
    await useWalletStore.getState().unlock(PASS);
    expect(useWalletStore.getState().getSecretKey()).toBe(LEGACY_SECRET);
    expect(await useWalletStore.getState().needsVaultSetup()).toBe(false);
  });

  it("shows the recovery phrase only with the passphrase", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await useWalletStore.getState().createWalletFromMnemonic("Main", "", PHRASE, 0);
    await expect(useWalletStore.getState().revealMnemonic("not the passphrase")).rejects.toThrow(/wrong passphrase/i);
    expect(await useWalletStore.getState().revealMnemonic(PASS)).toBe(PHRASE);
  });

  it("changes the passphrase without touching the sealed keys", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await useWalletStore.getState().importWallet("Old", LEGACY_SECRET, "");
    const sealedBefore = secure.get(`secret_${LEGACY_PUBLIC}`);
    await useWalletStore.getState().changePassphrase(PASS, "a different long passphrase");
    expect(secure.get(`secret_${LEGACY_PUBLIC}`)).toBe(sealedBefore);
    useWalletStore.getState().lock();
    await expect(useWalletStore.getState().unlock(PASS)).rejects.toThrow(/wrong passphrase/i);
    await useWalletStore.getState().unlock("a different long passphrase");
    expect(useWalletStore.getState().getSecretKey()).toBe(LEGACY_SECRET);
  });
});

describe("changing the passphrase", () => {
  beforeEach(reset);

  it("refuses a wrong current passphrase and leaves the old one working", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await expect(useWalletStore.getState().changePassphrase("not the passphrase", "a different long passphrase")).rejects.toThrow(/wrong passphrase/i);
    useWalletStore.getState().lock();
    await useWalletStore.getState().unlock(PASS);
    expect(useWalletStore.getState().isUnlocked).toBe(true);
  });

  it("refuses a weak new passphrase and leaves the old one working", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await expect(useWalletStore.getState().changePassphrase(PASS, "short")).rejects.toThrow(/at least 12/i);
    await expect(useWalletStore.getState().changePassphrase(PASS, "123456789012")).rejects.toThrow(/not only numbers/i);
    useWalletStore.getState().lock();
    await useWalletStore.getState().unlock(PASS);
    expect(useWalletStore.getState().isUnlocked).toBe(true);
  });

  it("keeps fingerprint unlock working after the passphrase changes", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await useWalletStore.getState().importWallet("Old", LEGACY_SECRET, "");
    await useWalletStore.getState().enableBiometricUnlock();
    await useWalletStore.getState().changePassphrase(PASS, "a different long passphrase");
    useWalletStore.getState().lock();
    expect(await useWalletStore.getState().unlockWithBiometrics()).toBe(true);
    expect(useWalletStore.getState().getSecretKey()).toBe(LEGACY_SECRET);
  });
});

describe("biometric quick unlock (D8)", () => {
  beforeEach(reset);

  it("is not offered on a phone with no fingerprint or face sensor, or none set up", async () => {
    await useWalletStore.getState().setupVault(PASS);
    expect(await useWalletStore.getState().biometricUnlockAvailable()).toBe(true);
    bio.hardware = false;
    expect(await useWalletStore.getState().biometricUnlockAvailable()).toBe(false);
    await expect(useWalletStore.getState().enableBiometricUnlock()).rejects.toThrow(/fingerprint/i);
    expect(await useWalletStore.getState().biometricUnlockEnabled()).toBe(false);
    bio.hardware = true;
    bio.enrolled = false;
    expect(await useWalletStore.getState().biometricUnlockAvailable()).toBe(false);
    bio.enrolled = true;
  });

  it("is not offered for a weak biometric such as 2D face unlock, which cannot open the protected key", async () => {
    await useWalletStore.getState().setupVault(PASS);
    bio.level = 2; // BIOMETRIC_WEAK: enrolled, but Android will not let it unlock a protected key
    expect(await useWalletStore.getState().biometricUnlockAvailable()).toBe(false);
    await expect(useWalletStore.getState().enableBiometricUnlock()).rejects.toThrow(/fingerprint/i);
    expect(await useWalletStore.getState().biometricUnlockEnabled()).toBe(false);
  });

  it("keeps a biometric-protected copy of the vault key and unlocks with it", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await useWalletStore.getState().importWallet("Old", LEGACY_SECRET, "");
    await useWalletStore.getState().enableBiometricUnlock();
    const bioItem = [...secureOptions.entries()].find(([, o]) => (o as { requireAuthentication?: boolean })?.requireAuthentication);
    expect(bioItem).toBeTruthy();

    useWalletStore.getState().lock();
    expect(await useWalletStore.getState().unlockWithBiometrics()).toBe(true);
    expect(useWalletStore.getState().getSecretKey()).toBe(LEGACY_SECRET);
  });

  it("switches itself off when the biometric key is invalidated, and the passphrase still works", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await useWalletStore.getState().importWallet("Old", LEGACY_SECRET, "");
    await useWalletStore.getState().enableBiometricUnlock();
    useWalletStore.getState().lock();
    bioReadFails = true;

    expect(await useWalletStore.getState().unlockWithBiometrics()).toBe(false);
    expect(await useWalletStore.getState().biometricUnlockEnabled()).toBe(false);
    await useWalletStore.getState().unlock(PASS);
    expect(useWalletStore.getState().getSecretKey()).toBe(LEGACY_SECRET);
  });
});

describe("wrong-guess delays (D8)", () => {
  beforeEach(reset);

  it("blocks unlocking for a while after 5 wrong passphrases, then a right one resets the count", async () => {
    const { attemptPolicy } = await import("../../lib/key-vault");
    await useWalletStore.getState().setupVault(PASS);
    useWalletStore.getState().lock();
    for (let i = 0; i < 5; i++) await expect(useWalletStore.getState().unlock("wrong passphrase " + i)).rejects.toThrow(/wrong passphrase/i);

    // Even the right passphrase is refused during the delay.
    await expect(useWalletStore.getState().unlock(PASS)).rejects.toThrow(/try again in/i);
    expect(attemptPolicy.delayAfter(5)).toBe(30_000);
    expect(attemptPolicy.delayAfter(8)).toBeGreaterThan(attemptPolicy.delayAfter(6));

    // Persisted, so restarting the app does not reset it.
    expect(asyncStore.get("amma-unlock-attempts")).toContain('"failures":5');

    // The lock screen counts down from the stored time, so it is right after a restart too.
    const left = await useWalletStore.getState().unlockWaitMs();
    expect(left).toBeGreaterThan(29_000);
    expect(left).toBeLessThanOrEqual(30_000);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    await useWalletStore.getState().unlock(PASS);
    expect(JSON.parse(asyncStore.get("amma-unlock-attempts")!).failures).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("forgotten passphrase (D8)", () => {
  beforeEach(reset);

  it("wipes this phone's keys and passphrase so the wallet can be restored by recovery phrase", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await useWalletStore.getState().createWalletFromMnemonic("Main", "", PHRASE, 0);
    await useWalletStore.getState().forgetDeviceKeys();
    expect(secure.size).toBe(0);
    expect(await useWalletStore.getState().needsVaultSetup()).toBe(true);
    await useWalletStore.getState().setupVault("a brand new passphrase");
    await useWalletStore.getState().importFromMnemonic("Main", PHRASE, "", 0);
    expect(useWalletStore.getState().getSecretKey()).toBe(LEGACY_SECRET);
  });
});

describe("restoring keys for a wallet that came from another device", () => {
  beforeEach(reset);

  // The laptop's wallet is copied to the phone's list by the server sync, but its keys never are.
  async function syncedWallet(publicKey: string, name = "wallet") {
    await useWalletStore.getState().setupVault(PASS);
    useWalletStore.setState({
      accounts: [{ id: "s1", serverId: 7, name, publicKey, encryptedSecret: `secret_${publicKey}` }],
      activeAccountId: "s1",
    });
    useWalletStore.getState().lock();
    await useWalletStore.getState().unlock(PASS);
  }

  it("says the active wallet has no keys on this phone, then has them after a restore", async () => {
    await syncedWallet(LEGACY_PUBLIC);
    expect(await useWalletStore.getState().activeWalletHasKeys()).toBe(false);
    await useWalletStore.getState().importWallet("wallet", LEGACY_SECRET, "");
    expect(await useWalletStore.getState().activeWalletHasKeys()).toBe(true);
  });

  it("attaches a secret key to the same wallet instead of refusing it as a duplicate", async () => {
    await syncedWallet(LEGACY_PUBLIC);
    await useWalletStore.getState().importWallet("wallet", LEGACY_SECRET, "");
    const s = useWalletStore.getState();
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0].id).toBe("s1");
    expect(s.accounts[0].serverId).toBe(7);
    expect(s.getSecretKey()).toBe(LEGACY_SECRET);
    const stored = secure.get(`secret_${LEGACY_PUBLIC}`)!;
    expect(isSealed(stored)).toBe(true);
  });

  it("attaches a recovery phrase to the same wallet and keeps it as a seed-phrase wallet", async () => {
    // Find the address of the test phrase, then pretend it was synced without keys.
    await useWalletStore.getState().setupVault(PASS);
    const first = await useWalletStore.getState().importFromMnemonic("tmp", PHRASE, "", 0);
    const address = typeof first === "string" ? first : (first as { publicKey: string }).publicKey;
    secure.delete(`secret_${address}`);
    secure.delete(`mnemonic_${address}`);
    useWalletStore.setState({
      accounts: [{ id: "s1", serverId: 7, name: "wallet", publicKey: address, encryptedSecret: `secret_${address}` }],
      activeAccountId: "s1",
    });
    useWalletStore.getState().lock();
    await useWalletStore.getState().unlock(PASS);
    expect(await useWalletStore.getState().activeWalletHasKeys()).toBe(false);

    await useWalletStore.getState().importFromMnemonic("wallet", PHRASE, "", 0);

    const s = useWalletStore.getState();
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0]).toMatchObject({ id: "s1", serverId: 7, isHD: true, derivationIndex: 0 });
    expect(s.getSecretKey()).toMatch(/^S[A-Z2-7]{55}$/);
    expect(await s.revealMnemonic(PASS)).toBe(PHRASE);
    expect(isSealed(secure.get(`mnemonic_${address}`)!)).toBe(true);
  });

  it("still refuses a wallet that already has its keys here", async () => {
    await useWalletStore.getState().setupVault(PASS);
    await useWalletStore.getState().importWallet("Old", LEGACY_SECRET, "");
    await expect(useWalletStore.getState().importWallet("Other", LEGACY_SECRET, "")).rejects.toThrow(/already exists/i);
  });

  it("will not restore while the vault is locked", async () => {
    await syncedWallet(LEGACY_PUBLIC);
    useWalletStore.getState().lock();
    await expect(useWalletStore.getState().importWallet("wallet", LEGACY_SECRET, "")).rejects.toThrow(/unlock/i);
    expect(secure.has(`secret_${LEGACY_PUBLIC}`)).toBe(false);
  });
});

describe("restoring a wallet's key from the server backup", () => {
  beforeEach(reset);
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const LAPTOP_PASS = "laptop passphrase here";

  function copyOf(secret: string, passphrase: string, iterations = 1000): string {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, "sha256");
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return Buffer.concat([salt, iv, ct, cipher.getAuthTag()]).toString("base64");
  }

  async function syncedWallet(publicKey: string) {
    const { backupConfig } = await import("../../lib/backup-secret");
    backupConfig.iterations = 1000;
    const { useAuthStore } = await import("../auth");
    useAuthStore.setState({ accessToken: "token" } as never);
    await useWalletStore.getState().setupVault(PASS);
    useWalletStore.setState({
      accounts: [{ id: "s1", serverId: 7, name: "wallet", publicKey, encryptedSecret: `secret_${publicKey}` }],
      activeAccountId: "s1",
    });
    useWalletStore.getState().lock();
    await useWalletStore.getState().unlock(PASS);
  }
  const serve = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));

  it("opens the server copy with the passphrase it was made with and seals the key on this phone", async () => {
    await syncedWallet(LEGACY_PUBLIC);
    serve(200, { encryptedSecret: copyOf(LEGACY_SECRET, LAPTOP_PASS) });
    await useWalletStore.getState().restoreFromServerBackup(LAPTOP_PASS);
    const s = useWalletStore.getState();
    expect(s.accounts).toHaveLength(1);
    expect(s.getSecretKey()).toBe(LEGACY_SECRET);
    expect(isSealed(secure.get(`secret_${LEGACY_PUBLIC}`)!)).toBe(true);
    expect(await s.activeWalletHasKeys()).toBe(true);
  });

  it("asks the server only for this wallet's copy", async () => {
    await syncedWallet(LEGACY_PUBLIC);
    serve(200, { encryptedSecret: copyOf(LEGACY_SECRET, LAPTOP_PASS) });
    await useWalletStore.getState().restoreFromServerBackup(LAPTOP_PASS);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/\/api\/v1\/wallets\/7\/secret$/);
    expect(init.headers.Authorization).toBe("Bearer token");
  });

  it("says so when the passphrase is not the one the wallet was made with, and stores nothing", async () => {
    await syncedWallet(LEGACY_PUBLIC);
    serve(200, { encryptedSecret: copyOf(LEGACY_SECRET, LAPTOP_PASS) });
    await expect(useWalletStore.getState().restoreFromServerBackup("a different passphrase")).rejects.toThrow(/passphrase/i);
    expect(secure.has(`secret_${LEGACY_PUBLIC}`)).toBe(false);
    expect(await useWalletStore.getState().activeWalletHasKeys()).toBe(false);
  });

  it("refuses a copy whose key belongs to a different address", async () => {
    await syncedWallet(`G${"B".repeat(55)}`);
    serve(200, { encryptedSecret: copyOf(LEGACY_SECRET, LAPTOP_PASS) });
    await expect(useWalletStore.getState().restoreFromServerBackup(LAPTOP_PASS)).rejects.toThrow(/does not match/i);
    expect(secure.has(`secret_G${"B".repeat(55)}`)).toBe(false);
  });

  it("explains when the server has no copy or the user keeps their own keys", async () => {
    await syncedWallet(LEGACY_PUBLIC);
    serve(404, { error: "No stored key for this wallet" });
    await expect(useWalletStore.getState().restoreFromServerBackup(LAPTOP_PASS)).rejects.toThrow(/no backup/i);
    serve(409, { error: "You keep your own keys." });
    await expect(useWalletStore.getState().restoreFromServerBackup(LAPTOP_PASS)).rejects.toThrow(/own keys/i);
  });

  it("will not run while the vault is locked", async () => {
    await syncedWallet(LEGACY_PUBLIC);
    useWalletStore.getState().lock();
    serve(200, { encryptedSecret: copyOf(LEGACY_SECRET, LAPTOP_PASS) });
    await expect(useWalletStore.getState().restoreFromServerBackup(LAPTOP_PASS)).rejects.toThrow(/unlock/i);
  });
});
