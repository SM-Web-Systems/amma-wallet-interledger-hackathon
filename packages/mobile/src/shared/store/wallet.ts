import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Keypair } from "@stellar/stellar-sdk";
import { useAuthStore } from "./auth";
import {
  generateMnemonic as genMnemonic,
  keypairFromMnemonic,
  normalizeMnemonic,
  validateMnemonic,
} from "../lib/hd-wallet";
import { createVaultKey } from "../lib/vault";
import { passphraseProblem } from "../lib/passphrase";
import {
  biometricEnabled,
  biometricsAvailable,
  deleteBiometricKey,
  deleteSecretItem,
  deleteVault,
  hasVault,
  openVaultKey,
  readBiometricKey,
  readSecret,
  recordFailedUnlock,
  recordGoodUnlock,
  saveBiometricKey,
  saveWrappedKey,
  sealInPlace,
  setBiometricFlag,
  storeSecret,
  unlockWait,
  waitMessage,
} from "../lib/key-vault";
import { API_BASE } from "../lib/config";
import { openBackupSecret, sealBackupSecret } from "../lib/backup-secret";
import { NETWORK_LOCK, effectiveNetwork } from "../lib/network-lock";


export interface WalletAccount {
  id: string;
  serverId?: number;
  name: string;
  publicKey: string;
  encryptedSecret: string;
  derivationIndex?: number;
  isHD?: boolean;
}

interface WalletState {
  accounts: WalletAccount[];
  activeAccountId: string | null;
  network: "testnet" | "public";
  isUnlocked: boolean;
  _secretKey: string | null;
  /** Vault key while unlocked; memory only, never persisted (D8). */
  _vaultKey: Uint8Array | null;
  _syncing: boolean;

  /** True until this device has a wallet passphrase (new install, or an older install to migrate). */
  needsVaultSetup: () => Promise<boolean>;
  /** Sets the passphrase and encrypts any plain-text keys left by older versions. */
  setupVault: (passphrase: string) => Promise<void>;
  changePassphrase: (current: string, next: string) => Promise<void>;
  /** Checks the passphrase and returns the active wallet's recovery phrase. */
  revealMnemonic: (passphrase: string) => Promise<string>;
  /** False on a phone with no fingerprint or face sensor, or none set up. */
  biometricUnlockAvailable: () => Promise<boolean>;
  /** Milliseconds until another passphrase try is allowed (0 when allowed now). */
  unlockWaitMs: () => Promise<number>;
  biometricUnlockEnabled: () => Promise<boolean>;
  enableBiometricUnlock: () => Promise<void>;
  disableBiometricUnlock: () => Promise<void>;
  /** Unlocks with Face ID / fingerprint. False when cancelled or not available. */
  unlockWithBiometrics: () => Promise<boolean>;
  /** Forgotten passphrase: deletes this phone's encrypted keys and passphrase. Wallets come back by recovery phrase. */
  forgetDeviceKeys: () => Promise<void>;

  createWallet: (name: string, pin: string) => Promise<string>;
  importWallet: (name: string, secretKey: string, pin: string) => Promise<string>;
  switchAccount: (id: string) => void;
  removeAccount: (id: string) => void;
  renameAccount: (id: string, name: string) => void;
  /** Unlocks with the wallet passphrase. Wrong guesses are delayed after 5 tries. */
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  logout: () => void;
  getSecretKey: () => string | null;
  /** False for a wallet copied from another device: its keys are not on this phone until restored. */
  activeWalletHasKeys: () => Promise<boolean>;
  /**
   * Gets the active wallet's key from its server copy and seals it on this phone.
   * `passphrase` is the one the wallet was created with (on the device that made it).
   */
  restoreFromServerBackup: (passphrase: string) => Promise<void>;
  /**
   * Managed wallet: give Amma a sealed backup of this recovery phrase. Never throws and never logs the phrase.
   * "off" = the server has backup switched off, "self-custody" = the user keeps their own keys.
   */
  backupRecoveryPhrase: (phrase: string) => Promise<"saved" | "off" | "self-custody" | "failed">;
  /**
   * Turning the Amma backup on from this phone: send a passphrase-sealed copy of each wallet key held here
   * (the format the web app and server use). Checks the passphrase first and throws a plain message on any problem.
   */
  uploadKeysForBackup: (passphrase: string) => Promise<void>;
  setNetwork: (n: "testnet" | "public") => void;
  syncFromServer: (accessToken: string) => Promise<void>;
  createWalletFromMnemonic: (
    name: string,
    pin: string,
    mnemonic: string,
    accountIndex?: number
  ) => Promise<{ publicKey: string; mnemonic: string }>;
  importFromMnemonic: (
    name: string,
    mnemonic: string,
    pin: string,
    accountIndex?: number
  ) => Promise<string>;
  generateMnemonic: () => string;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function getToken(): string | null {
  return useAuthStore.getState().accessToken;
}

async function serverRequest(path: string, options: RequestInit = {}) {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.headers as Record<string, string>),
      },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Keys are generated and checked on the device (secure random via
// react-native-get-random-values). The secret key stays in this device's
// SecureStore (sealed by the vault, D8) and is never sent to a server (audit F-1 / TODO D1).
async function generateKeypair(): Promise<{ publicKey: string; secretKey: string }> {
  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), secretKey: keypair.secret() };
}

/** Secret items for an account: its key and, for HD wallets, its recovery phrase. */
function secretItems(a: WalletAccount): string[] {
  return [a.encryptedSecret, `mnemonic_${a.publicKey}`];
}

async function sealLegacySecrets(vaultKey: Uint8Array, accounts: WalletAccount[]): Promise<void> {
  for (const a of accounts) for (const item of secretItems(a)) await sealInPlace(vaultKey, item);
}

/** Opens the vault key with the passphrase, applying the wrong-guess delays. */
async function openWithPassphrase(passphrase: string): Promise<Uint8Array> {
  const wait = await unlockWait();
  if (wait > 0) throw new Error(waitMessage(wait));
  try {
    const key = await openVaultKey(passphrase);
    await recordGoodUnlock();
    return key;
  } catch (err) {
    if ((err as Error).message === "Wrong passphrase") {
      await recordFailedUnlock();
      throw new Error("Wrong passphrase.");
    }
    throw err;
  }
}

async function publicKeyFromSecret(secret: string): Promise<string> {
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    throw new Error("Invalid secret key");
  }
}

/**
 * Puts a wallet's keys on this phone when the wallet was copied here from another
 * device (so it is listed but has no keys). Refuses a wallet that already has keys.
 */
async function restoreKeysFor(
  get: () => WalletState,
  set: (partial: Partial<WalletState>) => void,
  existing: WalletAccount,
  secretKey: string,
  phrase?: { mnemonic: string; accountIndex: number }
): Promise<void> {
  const vaultKey = requireVaultKey(get()._vaultKey);
  if ((await readSecret(vaultKey, existing.encryptedSecret)) !== null) {
    throw new Error("Wallet already exists");
  }
  const storeKey = `secret_${existing.publicKey}`;
  await storeSecret(vaultKey, storeKey, secretKey);
  if (phrase) {
    await storeSecret(vaultKey, `mnemonic_${existing.publicKey}`, phrase.mnemonic);
  }
  const restored: WalletAccount = {
    ...existing,
    encryptedSecret: storeKey,
    ...(phrase ? { isHD: true, derivationIndex: phrase.accountIndex } : {}),
  };
  set({
    accounts: get().accounts.map((a) => (a.id === existing.id ? restored : a)),
    activeAccountId: existing.id,
    isUnlocked: true,
    _secretKey: secretKey,
  });
}

function requireVaultKey(key: Uint8Array | null): Uint8Array {
  if (!key) throw new Error("Unlock the wallet first.");
  return key;
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      accounts: [],
      activeAccountId: null,
      network: "testnet",
      isUnlocked: false,
      _secretKey: null,
      _vaultKey: null,
      _syncing: false,

      syncFromServer: async (accessToken: string) => {
        if (get()._syncing) return;
        set({ _syncing: true });
        try {
          const res = await fetch(`${API_BASE}/api/v1/wallets`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!res.ok) { set({ _syncing: false }); return; }
          const serverWallets = await res.json();
          if (!serverWallets || serverWallets.length === 0) {
            set({ _syncing: false });
            return;
          }

          const localAccounts = get().accounts;
          const merged: WalletAccount[] = [];
          const seenPubkeys = new Set<string>();

          for (const local of localAccounts) {
            const serverMatch = serverWallets.find((sw: any) => sw.publicKey === local.publicKey);
            merged.push({
              ...local,
              serverId: serverMatch?.id ?? local.serverId,
            });
            seenPubkeys.add(local.publicKey);
          }

          for (const sw of serverWallets) {
            if (!seenPubkeys.has(sw.publicKey)) {
              // Keys never come from the server (D1): restore this wallet with its
              // recovery phrase or secret key to sign on this device.
              merged.push({
                id: generateId(),
                serverId: sw.id,
                name: sw.name,
                publicKey: sw.publicKey,
                encryptedSecret: `secret_${sw.publicKey}`,
              });
            }
          }

          const activeServer = serverWallets.find((sw: any) => sw.isActive);
          const currentActiveId = get().activeAccountId;
          let newActiveId = currentActiveId;

          if (!currentActiveId || !merged.find((m) => m.id === currentActiveId)) {
            if (activeServer) {
              const match = merged.find((m) => m.publicKey === activeServer.publicKey);
              newActiveId = match?.id ?? merged[0]?.id ?? null;
            } else {
              newActiveId = merged[0]?.id ?? null;
            }
          }

          set({ accounts: merged, activeAccountId: newActiveId, _syncing: false });
        } catch (err) {
          console.error("Wallet sync failed:", err);
          set({ _syncing: false });
        }
      },

      createWallet: async (name: string, _pin: string) => {
        const trimmedName = (name || `Wallet ${get().accounts.length + 1}`).trim();
        if (get().accounts.some((a) => a.name.toLowerCase() === trimmedName.toLowerCase())) {
          throw new Error("A wallet with this name already exists");
        }

        const { publicKey, secretKey } = await generateKeypair();

        const storeKey = `secret_${publicKey}`;
        await storeSecret(requireVaultKey(get()._vaultKey), storeKey, secretKey);

        // Sync to server FIRST
        let serverId: number | undefined;
        try {
          const serverWallet = await serverRequest("/api/v1/wallets", {
            method: "POST",
            body: JSON.stringify({
              name: trimmedName,
              publicKey,
              network: get().network,
            }),
          });
          serverId = serverWallet?.id;
        } catch {}

        if (get().network === "testnet") {
          try {
            await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
          } catch {}
        }

        const account: WalletAccount = {
          id: generateId(),
          serverId,
          name: trimmedName,
          publicKey,
          encryptedSecret: storeKey,
        };

        set((s) => ({
          accounts: [...s.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
        }));

        return publicKey;
      },

      importWallet: async (name: string, secretKey: string, _pin: string) => {
        const trimmedName = (name || `Imported ${get().accounts.length + 1}`).trim();
        const publicKey = await publicKeyFromSecret(secretKey);

        const existing = get().accounts.find((a) => a.publicKey === publicKey);
        if (existing) {
          // A wallet copied from another device has no keys here: attach them to it.
          await restoreKeysFor(get, set, existing, secretKey);
          return publicKey;
        }
        if (get().accounts.some((a) => a.name.toLowerCase() === trimmedName.toLowerCase())) {
          throw new Error("A wallet with this name already exists");
        }

        const storeKey = `secret_${publicKey}`;
        await storeSecret(requireVaultKey(get()._vaultKey), storeKey, secretKey);

        // Sync to server FIRST
        let serverId: number | undefined;
        try {
          const serverWallet = await serverRequest("/api/v1/wallets", {
            method: "POST",
            body: JSON.stringify({
              name: trimmedName,
              publicKey,
              network: get().network,
            }),
          });
          serverId = serverWallet?.id;
        } catch {}

        const account: WalletAccount = {
          id: generateId(),
          serverId,
          name: trimmedName,
          publicKey,
          encryptedSecret: storeKey,
        };

        set((s) => ({
          accounts: [...s.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
        }));

        return publicKey;
      },

      switchAccount: (id) => {
        const account = get().accounts.find((a) => a.id === id);
        if (account?.serverId) {
          serverRequest(`/api/v1/wallets/${account.serverId}/activate`, {
            method: "PATCH",
            body: JSON.stringify({}),
          }).catch(console.error);
        }
        const vaultKey = get()._vaultKey;
        set({ activeAccountId: id, _secretKey: null, isUnlocked: !!vaultKey });
        if (vaultKey && account) {
          readSecret(vaultKey, account.encryptedSecret)
            .then((secret) => { if (get().activeAccountId === id) set({ _secretKey: secret }); })
            .catch(() => {});
        }
      },

      removeAccount: (id) => {
        const account = get().accounts.find((a) => a.id === id);
        if (account?.serverId) {
          serverRequest(`/api/v1/wallets/${account.serverId}`, {
            method: "DELETE",
          }).catch(console.error);
        }
        set((s) => {
          const accounts = s.accounts.filter((a) => a.id !== id);
          return {
            accounts,
            activeAccountId: accounts.length > 0 ? accounts[0].id : null,
            _secretKey: null,
          };
        });
      },

      renameAccount: (id, name) => {
        const account = get().accounts.find((a) => a.id === id);
        if (account?.serverId) {
          serverRequest(`/api/v1/wallets/${account.serverId}`, {
            method: "PATCH",
            body: JSON.stringify({ name }),
          }).catch(console.error);
        }
        set((s) => ({
          accounts: s.accounts.map((a) => (a.id === id ? { ...a, name } : a)),
        }));
      },

      needsVaultSetup: async () => !(await hasVault()),

      setupVault: async (passphrase: string) => {
        const problem = passphraseProblem(passphrase);
        if (problem) throw new Error(problem.replace("at least 12", "at least 12 characters").replace("characters characters", "characters"));
        if (await hasVault()) throw new Error("This device already has a wallet passphrase.");
        const vaultKey = createVaultKey();
        await saveWrappedKey(vaultKey, passphrase);
        await sealLegacySecrets(vaultKey, get().accounts);
        const active = get().accounts.find((a) => a.id === get().activeAccountId);
        const secret = active ? await readSecret(vaultKey, active.encryptedSecret) : null;
        set({ _vaultKey: vaultKey, isUnlocked: true, _secretKey: secret });
      },

      unlock: async (passphrase: string) => {
        const vaultKey = await openWithPassphrase(passphrase);
        // Finish a migration that an older install started but did not complete.
        await sealLegacySecrets(vaultKey, get().accounts);
        const active = get().accounts.find((a) => a.id === get().activeAccountId);
        // A wallet synced from another device has no key here: the app unlocks, signing needs a restore.
        const secret = active ? await readSecret(vaultKey, active.encryptedSecret) : null;
        set({ _vaultKey: vaultKey, isUnlocked: true, _secretKey: secret });
      },

      changePassphrase: async (current: string, next: string) => {
        const problem = passphraseProblem(next);
        if (problem) throw new Error(problem);
        const vaultKey = await openWithPassphrase(current);
        await saveWrappedKey(vaultKey, next);
      },

      revealMnemonic: async (passphrase: string) => {
        const vaultKey = await openWithPassphrase(passphrase);
        const active = get().accounts.find((a) => a.id === get().activeAccountId);
        const phrase = active ? await readSecret(vaultKey, `mnemonic_${active.publicKey}`) : null;
        if (!phrase) throw new Error("No recovery phrase is stored for this wallet on this device.");
        return phrase;
      },

      biometricUnlockAvailable: () => biometricsAvailable(),
      unlockWaitMs: () => unlockWait(),
      biometricUnlockEnabled: () => biometricEnabled(),

      enableBiometricUnlock: async () => {
        const vaultKey = requireVaultKey(get()._vaultKey);
        if (!(await biometricsAvailable())) throw new Error("Quick unlock needs a fingerprint or secure face unlock, and this phone has neither set up. Your passphrase works.");
        await saveBiometricKey(vaultKey);
        await setBiometricFlag(true);
      },

      disableBiometricUnlock: async () => {
        await deleteBiometricKey();
      },

      unlockWithBiometrics: async () => {
        if (!(await biometricEnabled())) return false;
        const result = await readBiometricKey();
        if (!result.key) {
          if (result.reason === "invalid") await deleteBiometricKey(); // passphrase still works
          return false;
        }
        const vaultKey = result.key;
        const active = get().accounts.find((a) => a.id === get().activeAccountId);
        let secret: string | null = null;
        try {
          secret = active ? await readSecret(vaultKey, active.encryptedSecret) : null;
        } catch {
          await deleteBiometricKey(); // stale copy that no longer opens the vault
          return false;
        }
        await recordGoodUnlock();
        set({ _vaultKey: vaultKey, isUnlocked: true, _secretKey: secret });
        return true;
      },

      forgetDeviceKeys: async () => {
        await deleteBiometricKey();
        for (const a of get().accounts) for (const item of secretItems(a)) await deleteSecretItem(item);
        await deleteVault();
        await recordGoodUnlock();
        set({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _vaultKey: null });
      },

      lock: () => set({ isUnlocked: false, _secretKey: null, _vaultKey: null }),
      logout: () => set({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _vaultKey: null }),
      getSecretKey: () => get()._secretKey,
      restoreFromServerBackup: async (passphrase: string) => {
        const vaultKey = requireVaultKey(get()._vaultKey);
        const active = get().accounts.find((a) => a.id === get().activeAccountId);
        if (!active?.serverId) throw new Error("This wallet is not linked to your account.");
        if ((await readSecret(vaultKey, active.encryptedSecret)) !== null) {
          throw new Error("This wallet already has its keys on this phone.");
        }
        const token = getToken();
        if (!token) throw new Error("Sign in again to restore from the backup.");

        let res: Response;
        try {
          res = await fetch(`${API_BASE}/api/v1/wallets/${active.serverId}/secret`, {
            headers: { Authorization: `Bearer ${token}` },
          });
        } catch {
          throw new Error("Could not reach Amma. Check your connection and try again.");
        }
        if (res.status === 404) {
          throw new Error("Amma has no backup copy of this wallet. Restore it with its 12 words or secret key instead.");
        }
        if (res.status === 409) {
          throw new Error("You keep your own keys, so there is no backup to restore from. Use the 12 words or secret key.");
        }
        if (res.status === 429) throw new Error("Too many tries. Wait a few minutes and try again.");
        if (!res.ok) throw new Error("Could not get the backup. Try again in a moment.");
        const body = await res.json();

        const secretKey = await openBackupSecret(String(body?.encryptedSecret ?? ""), passphrase);
        if ((await publicKeyFromSecret(secretKey)) !== active.publicKey) {
          throw new Error("The stored key does not match this wallet's address, so it was not restored.");
        }
        await restoreKeysFor(get, set, active, secretKey);
      },

      uploadKeysForBackup: async (passphrase: string) => {
        const token = getToken();
        if (!token) throw new Error("Sign in again to turn the backup on.");
        let vaultKey: Uint8Array;
        try {
          vaultKey = await openWithPassphrase(passphrase);
        } catch {
          throw new Error("That passphrase is not correct.");
        }
        const { accounts, activeAccountId } = get();
        const active = accounts.find((a) => a.id === activeAccountId);
        if (!active?.serverId) throw new Error("This wallet is not linked to your account yet. Sign in again and retry.");
        const secrets = new Map<string, string>();
        for (const a of accounts) {
          const secret = await readSecret(vaultKey, a.encryptedSecret);
          if (secret !== null) secrets.set(a.id, secret);
        }
        if (!secrets.has(active.id)) {
          throw new Error("This phone has no key for the active wallet. Restore it first with your 12 words or secret key.");
        }
        const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
        const send = async (path: string, body: unknown) => {
          let res: Response;
          try {
            res = await fetch(`${API_BASE}${path}`, { method: "PATCH", headers, body: JSON.stringify(body) });
          } catch {
            throw new Error("Could not reach Amma. Check your connection and try again.");
          }
          if (!res.ok) throw new Error("Could not turn the backup on. Try again in a moment.");
        };
        // Delegated signing uses the server's active wallet: make it this one first, then send the copies.
        await send(`/api/v1/wallets/${active.serverId}/activate`, {});
        await send(`/api/v1/wallets/${active.serverId}/secret`, { encryptedSecret: await sealBackupSecret(secrets.get(active.id)!, passphrase) });
        for (const a of accounts) {
          if (a.id === active.id || !a.serverId || !secrets.has(a.id)) continue;
          await send(`/api/v1/wallets/${a.serverId}/secret`, { encryptedSecret: await sealBackupSecret(secrets.get(a.id)!, passphrase) });
        }
      },

      backupRecoveryPhrase: async (phrase: string) => {
        try {
          const clean = normalizeMnemonic(phrase);
          if (!validateMnemonic(clean)) return "failed";
          const token = getToken();
          if (!token) return "failed";
          const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
          const status = await fetch(`${API_BASE}/api/v1/key-escrow/status`, { headers });
          if (!status.ok) return "failed";
          if (!(await status.json())?.enabled) return "off";
          const mode = await fetch(`${API_BASE}/api/v1/user/signing-mode`, { headers });
          if (!mode.ok) return "failed";
          if ((await mode.json())?.signingMode === "self") return "self-custody";
          const saved = await fetch(`${API_BASE}/api/v1/key-escrow/phrase`, { method: "PUT", headers, body: JSON.stringify({ phrase: clean }) });
          return saved.ok ? "saved" : "failed";
        } catch {
          // Deliberately silent: an error message could carry request details.
          return "failed";
        }
      },

      activeWalletHasKeys: async () => {
        const { _vaultKey, accounts, activeAccountId } = get();
        const active = accounts.find((a) => a.id === activeAccountId);
        if (!_vaultKey || !active) return false;
        return (await readSecret(_vaultKey, active.encryptedSecret)) !== null;
      },
      setNetwork: (n) => set({ network: effectiveNetwork(n, NETWORK_LOCK) }),

      // ─── NEW: the three methods above go here ───
      generateMnemonic: () => {
        return genMnemonic();
      },

      // ─── Create wallet from a 24-word mnemonic ───
      createWalletFromMnemonic: async (
        name: string,
        _pin: string,
        mnemonic: string,
        accountIndex: number = 0
      ) => {
        const trimmedName = (
          name || `Wallet ${get().accounts.length + 1}`
        ).trim();

        if (
          get().accounts.some(
            (a) => a.name.toLowerCase() === trimmedName.toLowerCase()
          )
        ) {
          throw new Error("A wallet with this name already exists");
        }

        if (!validateMnemonic(mnemonic)) {
          throw new Error("Invalid mnemonic phrase");
        }

        const { publicKey, secretKey } = keypairFromMnemonic(
          mnemonic,
          accountIndex
        );

        if (get().accounts.some((a) => a.publicKey === publicKey)) {
          throw new Error("This wallet already exists");
        }

        const storeKey = `secret_${publicKey}`;
        await storeSecret(requireVaultKey(get()._vaultKey), storeKey, secretKey);

        // Store mnemonic securely
        const mnemonicKey = `mnemonic_${publicKey}`;
        await storeSecret(requireVaultKey(get()._vaultKey), mnemonicKey, normalizeMnemonic(mnemonic));

        // Sync to server
        let serverId: number | undefined;
        try {
          const serverWallet = await serverRequest("/api/v1/wallets", {
            method: "POST",
            body: JSON.stringify({
              name: trimmedName,
              publicKey,
              network: get().network,
            }),
          });
          serverId = serverWallet?.id;
        } catch {}

        // Fund on testnet
        if (get().network === "testnet") {
          try {
            await fetch(
              `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`
            );
          } catch {}
        }

        const account: WalletAccount = {
          id: generateId(),
          serverId,
          name: trimmedName,
          publicKey,
          encryptedSecret: storeKey,
          derivationIndex: accountIndex,
          isHD: true,
        };

        set((s) => ({
          accounts: [...s.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
        }));

        await get().backupRecoveryPhrase(mnemonic);

        return { publicKey, mnemonic: normalizeMnemonic(mnemonic) };
      },

      // ─── Import from mnemonic ───
      importFromMnemonic: async (
        name: string,
        mnemonic: string,
        _pin: string,
        accountIndex: number = 0
      ) => {
        const trimmedName = (
          name || `Imported ${get().accounts.length + 1}`
        ).trim();

        if (!validateMnemonic(mnemonic)) {
          throw new Error("Invalid mnemonic phrase. Check your words.");
        }

        const { publicKey, secretKey } = keypairFromMnemonic(
          mnemonic,
          accountIndex
        );

        const existing = get().accounts.find((a) => a.publicKey === publicKey);
        if (existing) {
          // A wallet copied from another device has no keys here: attach them to it.
          await restoreKeysFor(get, set, existing, secretKey, {
            mnemonic: normalizeMnemonic(mnemonic),
            accountIndex,
          });
          await get().backupRecoveryPhrase(mnemonic);
          return publicKey;
        }

        if (
          get().accounts.some(
            (a) => a.name.toLowerCase() === trimmedName.toLowerCase()
          )
        ) {
          throw new Error("A wallet with this name already exists");
        }

        const storeKey = `secret_${publicKey}`;
        await storeSecret(requireVaultKey(get()._vaultKey), storeKey, secretKey);

        const mnemonicKey = `mnemonic_${publicKey}`;
        await storeSecret(requireVaultKey(get()._vaultKey), mnemonicKey, normalizeMnemonic(mnemonic));

        let serverId: number | undefined;
        try {
          const serverWallet = await serverRequest("/api/v1/wallets", {
            method: "POST",
            body: JSON.stringify({
              name: trimmedName,
              publicKey,
              network: get().network,
            }),
          });
          serverId = serverWallet?.id;
        } catch {}

        const account: WalletAccount = {
          id: generateId(),
          serverId,
          name: trimmedName,
          publicKey,
          encryptedSecret: storeKey,
          derivationIndex: accountIndex,
          isHD: true,
        };

        set((s) => ({
          accounts: [...s.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
        }));

        await get().backupRecoveryPhrase(mnemonic);

        return publicKey;
      },
    }),
    {
      name: "amma-wallet-mobile",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        accounts: state.accounts,
        activeAccountId: state.activeAccountId,
        network: state.network,
      }),
      // A Mainnet value saved before the lock existed becomes testnet in a locked build.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<WalletState>;
        return { ...current, ...saved, network: effectiveNetwork(saved.network, NETWORK_LOCK) };
      },
    }
  )
);
