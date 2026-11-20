import { create } from "zustand";
import { persist } from "zustand/middleware";
import { generateKeypair, keypairFromSecret, fundTestnet } from "../lib/stellar";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { userWalletApi, signingApi, keyEscrowApi } from "../lib/api";
import { isLegacyPin, passphraseProblem } from "../lib/passphrase";
import { PIN_RETIRED_CODE, PIN_RETIRED_MESSAGE } from "../lib/pin-retire";
import { deleteStellarSecret, loadAllStellarSecrets, loadStellarSecret, migrateLegacyStellarSecrets, saveStellarSecret, setStellarKeystoreOwner } from "../lib/stellar-keystore";
import { deriveHDKeypair, generateRecoveryPhrase, isValidMnemonic, normalizeMnemonic, type RecoveryWordCount } from "../lib/hd-wallet";

export interface WalletAccount {
  id: string;
  serverId?: number;
  name: string;
  publicKey: string;
  encryptedSecret: string;
  createdAt: number;
  isHD?: boolean;
  derivationIndex?: number;
  /** The server still holds an encrypted copy of this key (from before D1, or delegated signing). */
  hasServerKey?: boolean;
  /** A new random-key wallet whose secret key the person has not yet confirmed saving. Gates the app until confirmed. */
  backupPending?: boolean;
}

/** Wallets on this browser that belong to someone other than the signed-in user. Keys stay in IndexedDB. */
type SetAside = Record<string, { accounts: WalletAccount[]; activeAccountId: string | null }>;
/** Bucket for wallets saved before owner binding, until a user whose server list holds them claims them. */
const LEGACY = "legacy";

interface WalletState {
  accounts: WalletAccount[];
  activeAccountId: string | null;
  /** The user these wallets belong to; null for wallets saved before owner binding. */
  ownerId: number | null;
  setAside: SetAside;
  network: "testnet" | "public";
  isUnlocked: boolean;
  _secretKey: string | null;
  _syncing: boolean;
  _mnemonic: string | null;
  /** The active wallet was unlocked with an old short PIN and should move to a passphrase. */
  needsPassphraseUpgrade: boolean;
  /** Did the browser grant persistent storage when the last device wallet was made? null = unknown or unsupported. */
  storagePersisted: boolean | null;

  getPublicKey: () => string | null;
  activeAccount: () => WalletAccount | null;
  createWallet: (name: string, pin: string) => Promise<string>;
  importWallet: (name: string, secretKey: string, pin: string) => Promise<string>;
  /** Named fields: positional (name, pin, mnemonic) strings were once passed in the wrong order. */
  createWalletFromMnemonic: (input: { name: string; pin: string; mnemonic: string; accountIndex?: number }) => Promise<{ publicKey: string; mnemonic: string }>;
  importFromMnemonic: (name: string, mnemonic: string, pin: string, accountIndex?: number) => Promise<string>;
  generateMnemonic: (wordCount?: RecoveryWordCount) => Promise<string>;
  /** The person confirmed they saved the secret key of this new wallet. */
  confirmBackup: (accountId: string) => Promise<void>;
  switchAccount: (accountId: string) => void;
  /** Delete only this device's copy of the key (not the wallet record). Used after "Move to Amma". */
  removeLocalKey: (accountId: string, expectedPublicKey: string) => Promise<void>;
  removeAccount: (accountId: string) => void;
  renameAccount: (accountId: string, newName: string) => void;
  unlock: (pin: string) => Promise<void>;
  /**
   * Settings: change the passphrase on this device. Every wallet here that opens with the current
   * passphrase moves to the new one; wallets under another passphrase are left as they are.
   * Resolves with how many wallets were changed.
   */
  changePassphrase: (current: string, next: string) => Promise<number>;
  /** Before enabling delegated signing: send this device's encrypted keys to the server. */
  uploadKeysForDelegatedSigning: () => Promise<void>;
  /**
   * This browser has no key for the active wallet (it was made on another device): get Amma's stored
   * copy and keep it here. `passphrase` is the one the wallet was made with; the copy is not re-encrypted.
   */
  restoreFromServerBackup: (passphrase: string) => Promise<void>;
  /**
   * Managed wallet: give Amma a sealed backup of this recovery phrase. Never throws and never logs the phrase.
   * "off" = the server has backup switched off, "self-custody" = the user keeps their own keys.
   */
  backupRecoveryPhrase: (phrase: string) => Promise<"saved" | "off" | "self-custody" | "failed">;
  /** After a wallet recovery: re-encrypt every local wallet of this phrase under a new passphrase (the old one is forgotten). */
  resetPassphraseFromPhrase: (phrase: string, newPassphrase: string) => Promise<{ updated: number; serverSynced: boolean }>;
  /** Self-custody: delete the server's copy of the active wallet's key, once this device is proven to hold it. */
  removeServerKeyCopy: () => Promise<void>;
  /** "Later": hide the prompt until the next unlock with a PIN. */
  dismissPassphraseUpgrade: () => void;
  lock: () => void;
  logout: () => void;
  getSecretKey: () => string;
  getMnemonic: () => string | null;
  setNetwork: (n: "testnet" | "public") => void;
  syncFromServer: () => Promise<void>;
  /**
   * Call on every sign-in, before syncFromServer. Another user's wallets are set aside, not deleted
   * (they may be the only copy). Wallets from before owner binding are claimed only if `serverPublicKeys`
   * (this user's server wallet list) contains them, otherwise they stay hidden.
   */
  claimFor: (userId: number, serverPublicKeys: string[]) => void;
}

/** Signing mode, read lazily: auth.ts imports this module. */
async function signingMode(): Promise<"self" | "delegated"> {
  const { useAuthStore } = await import("./auth");
  try {
    // Ask the server: a stale "self" would leave a delegated wallet without its server key.
    const mode = await signingApi.getMode();
    useAuthStore.setState({ signingMode: mode });
    return mode;
  } catch {
    return useAuthStore.getState().signingMode;
  }
}

/**
 * Audit F-1 / TODO D1: in self-custody mode the encrypted key stays on this
 * device. Only delegated signing, which signs on the server, sends a copy.
 */
async function serverKeyCopy(encrypted: string): Promise<{ encryptedSecret?: string }> {
  return (await signingMode()) === "delegated" ? { encryptedSecret: encrypted } : {};
}

/**
 * Write the encrypted key to this browser and prove it is there: read it back, open it with the passphrase and
 * compare the secret. A wallet is only created if this passes (H2). Also asks the browser not to clear storage.
 */
async function storeKeyDurably(publicKey: string, encrypted: string, secret: string, passphrase: string): Promise<boolean | null> {
  try {
    await saveStellarSecret(publicKey, encrypted);
    const back = await loadStellarSecret(publicKey);
    if (back !== encrypted) throw new Error("mismatch");
    if ((await decryptSecret(back, passphrase)) !== secret) throw new Error("mismatch");
  } catch {
    await deleteStellarSecret(publicKey).catch(() => {});
    throw new Error("Your wallet key could not be saved in this browser, so no wallet was created. Free some space or leave private browsing, then try again.");
  }
  try {
    const granted = await navigator.storage?.persist?.();
    return typeof granted === "boolean" ? granted : null;
  } catch {
    return false;
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      accounts: [],
      activeAccountId: null,
      ownerId: null,
      setAside: {},
      network: (import.meta.env.VITE_DEFAULT_NETWORK as "testnet" | "public") || "public",
      isUnlocked: false,
      _secretKey: null,
      _syncing: false,
      _mnemonic: null,
      needsPassphraseUpgrade: false,
      storagePersisted: null,

      getPublicKey: () => {
        const state = get();
        const active = state.accounts.find((a) => a.id === state.activeAccountId);
        return active?.publicKey ?? null;
      },

      activeAccount: () => {
        const state = get();
        return state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
      },

      // ─── Sync from server ─────────────────────
      claimFor: (userId, serverPublicKeys) => {
        const { ownerId, accounts, activeAccountId } = get();
        const aside: SetAside = { ...get().setAside };
        const keep = (list: WalletAccount[]) => list.map((a) => ({ ...a, encryptedSecret: "" }));
        let mine = accounts;
        let active = activeAccountId;
        let switched = false;
        if (ownerId !== userId) {
          switched = true;
          if (accounts.length > 0) {
            const key = ownerId == null ? LEGACY : String(ownerId);
            const earlier = (aside[key]?.accounts ?? []).filter((e) => !accounts.some((a) => a.publicKey === e.publicKey));
            aside[key] = { accounts: [...earlier, ...keep(accounts)], activeAccountId: activeAccountId ?? aside[key]?.activeAccountId ?? null };
          }
          mine = aside[String(userId)]?.accounts ?? [];
          active = aside[String(userId)]?.activeAccountId ?? null;
          delete aside[String(userId)];
        }
        const legacy = aside[LEGACY];
        if (legacy) {
          const claimed = legacy.accounts.filter((a) => serverPublicKeys.includes(a.publicKey) && !mine.some((m) => m.publicKey === a.publicKey));
          if (claimed.length > 0) {
            if (!active && claimed.some((a) => a.id === legacy.activeAccountId)) active = legacy.activeAccountId;
            mine = [...mine, ...claimed];
            const rest = legacy.accounts.filter((a) => !claimed.includes(a));
            if (rest.length > 0) aside[LEGACY] = { ...legacy, accounts: rest };
            else delete aside[LEGACY];
          }
        }
        set({
          accounts: mine,
          activeAccountId: active && mine.some((a) => a.id === active) ? active : null,
          setAside: aside,
          ownerId: userId,
          ...(switched ? { isUnlocked: false, _secretKey: null, _mnemonic: null, needsPassphraseUpgrade: false } : {}),
        });
        setStellarKeystoreOwner(userId);
        // Keys of wallets just claimed from the old layout move under this owner; returning wallets get their keys back.
        void migrateLegacyStellarSecrets(mine.map((a) => a.publicKey)).then(restoreSecretsFromKeystore);
      },

      syncFromServer: async () => {
        if (get()._syncing) return;
        set({ _syncing: true });
        try {
          const serverWallets = await userWalletApi.list();
          if (!serverWallets || serverWallets.length === 0) {
            set({ _syncing: false });
            return;
          }

          const localAccounts = get().accounts;
          const merged: WalletAccount[] = [];
          const seenPubkeys = new Set<string>();

          for (const local of localAccounts) {
            const serverMatch = serverWallets.find(
              (sw: any) => sw.publicKey === local.publicKey
            );
            merged.push({
              ...local,
              serverId: serverMatch?.id ?? local.serverId,
              hasServerKey: serverMatch ? Boolean(serverMatch.hasServerKey) : local.hasServerKey,
              encryptedSecret: local.encryptedSecret, // keys never come from the server (D1)
            });
            seenPubkeys.add(local.publicKey);
          }

          for (const sw of serverWallets) {
            if (!seenPubkeys.has(sw.publicKey)) {
              merged.push({
                id: generateId(),
                serverId: sw.id,
                hasServerKey: Boolean(sw.hasServerKey),
                name: sw.name,
                publicKey: sw.publicKey,
                encryptedSecret: "",
                createdAt: new Date(sw.createdAt).getTime(),
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

          set({
            accounts: merged,
            activeAccountId: newActiveId,
            _syncing: false,
          });
        } catch (err) {
          console.error("Wallet sync failed:", err);
          set({ _syncing: false });
        }
      },

      // ─── Create (random keypair) ──────────────
      createWallet: async (name, pin) => {
        const trimmedName = (name || `Wallet ${get().accounts.length + 1}`).trim();
        if (get().accounts.some((a) => a.name.toLowerCase() === trimmedName.toLowerCase())) {
          throw new Error("A wallet with this name already exists");
        }

        const { publicKey, secretKey } = generateKeypair();
        const encrypted = await encryptSecret(secretKey, pin);
        const storagePersisted = await storeKeyDurably(publicKey, encrypted, secretKey, pin);

        const account: WalletAccount = {
          id: generateId(),
          name: trimmedName,
          publicKey,
          encryptedSecret: encrypted,
          createdAt: Date.now(),
          backupPending: true,
        };

        set((state) => ({
          accounts: [...state.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
          storagePersisted,
        }));

        // On testnet builds, auto-fund new wallets via Friendbot
        if (import.meta.env.VITE_DEFAULT_NETWORK === "testnet") {
          fundTestnet(publicKey).catch(() => {});
        }

        return publicKey;
      },

      // ─── Import (secret key) ──────────────────
      importWallet: async (name, secretKey, pin) => {
        const { publicKey } = keypairFromSecret(secretKey);

        if (get().accounts.some((a) => a.publicKey === publicKey)) {
          throw new Error("This wallet is already added");
        }

        const encrypted = await encryptSecret(secretKey, pin);
        const storagePersisted = await storeKeyDurably(publicKey, encrypted, secretKey, pin);

        const account: WalletAccount = {
          id: generateId(),
          name: name || `Imported ${get().accounts.length + 1}`,
          publicKey,
          encryptedSecret: encrypted,
          createdAt: Date.now(),
        };

        try {
          const serverWallet = await userWalletApi.add({
            name: account.name,
            publicKey,
            ...(await serverKeyCopy(encrypted)),
            network: get().network,
          });
          account.serverId = serverWallet.id;
        } catch (err) {
          console.error("Failed to sync wallet to server:", err);
        }

        set((state) => ({
          accounts: [...state.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
          storagePersisted,
        }));

        return publicKey;
      },

      // ─── Generate mnemonic ────────────────────
      generateMnemonic: async (wordCount = 24) => generateRecoveryPhrase(wordCount),

      // ─── Create from mnemonic ─────────────────
      createWalletFromMnemonic: async ({ name, pin, mnemonic: rawMnemonic, accountIndex = 0 }) => {
        const mnemonic = normalizeMnemonic(rawMnemonic);
        const trimmedName = (name || `HD Wallet ${get().accounts.length + 1}`).trim();
        if (get().accounts.some((a) => a.name.toLowerCase() === trimmedName.toLowerCase())) {
          throw new Error("A wallet with this name already exists");
        }

        // Derive keypair client-side — mnemonic never leaves the browser
        const derived = deriveHDKeypair(mnemonic, accountIndex);
        const { publicKey, secretKey } = derived;

        if (get().accounts.some((a) => a.publicKey === publicKey)) {
          throw new Error("This wallet is already added");
        }

        const encrypted = await encryptSecret(secretKey, pin);
        const storagePersisted = await storeKeyDurably(publicKey, encrypted, secretKey, pin);

        let serverId: number | undefined;
        try {
          const serverWallet = await userWalletApi.add({
            name: trimmedName,
            publicKey,
            ...(await serverKeyCopy(encrypted)),
            network: get().network,
          });
          serverId = serverWallet.id;
        } catch (err: any) {
          if (err.message?.includes("already exists")) {
            await deleteStellarSecret(publicKey).catch(() => {});
            throw new Error("A wallet with this name already exists");
          }
          console.error("Failed to sync wallet to server:", err);
        }

        const account: WalletAccount = {
          id: generateId(),
          serverId,
          name: trimmedName,
          publicKey,
          encryptedSecret: encrypted,
          createdAt: Date.now(),
          isHD: true,
          derivationIndex: accountIndex,
        };

        set((state) => ({
          accounts: [...state.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
          _mnemonic: mnemonic,
          storagePersisted,
        }));

        // On testnet builds, auto-fund new wallets via Friendbot
        if (import.meta.env.VITE_DEFAULT_NETWORK === "testnet") {
          fundTestnet(publicKey).catch(() => {});
        }

        await get().backupRecoveryPhrase(mnemonic);

        return { publicKey, mnemonic };
      },

      // ─── Import from mnemonic ─────────────────
      importFromMnemonic: async (name, rawMnemonic, pin, accountIndex = 0) => {
        const mnemonic = normalizeMnemonic(rawMnemonic);
        // Validate mnemonic client-side — no server call needed
        if (!isValidMnemonic(mnemonic)) {
          throw new Error("Invalid recovery phrase");
        }

        const derived = deriveHDKeypair(mnemonic, accountIndex);
        const { publicKey, secretKey } = derived;

        if (get().accounts.some((a) => a.publicKey === publicKey)) {
          throw new Error("This wallet is already added");
        }

        const encrypted = await encryptSecret(secretKey, pin);
        const storagePersisted = await storeKeyDurably(publicKey, encrypted, secretKey, pin);

        let serverId: number | undefined;
        try {
          const serverWallet = await userWalletApi.add({
            name: name || `HD Wallet ${get().accounts.length + 1}`,
            publicKey,
            ...(await serverKeyCopy(encrypted)),
            network: get().network,
          });
          serverId = serverWallet.id;
        } catch (err) {
          console.error("Failed to sync wallet to server:", err);
        }

        const account: WalletAccount = {
          id: generateId(),
          serverId,
          name: name || `HD Wallet ${get().accounts.length + 1}`,
          publicKey,
          encryptedSecret: encrypted,
          createdAt: Date.now(),
          isHD: true,
          derivationIndex: accountIndex,
        };

        set((state) => ({
          accounts: [...state.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
          _mnemonic: mnemonic,
          storagePersisted,
        }));

        await get().backupRecoveryPhrase(mnemonic);

        return publicKey;
      },

      // A new random-key wallet is registered with the server only now, so nothing (a claim, a payment) can
      // be sent to an address whose key has not been saved by the person.
      confirmBackup: async (accountId) => {
        const account = get().accounts.find((a) => a.id === accountId);
        if (!account) return;
        let serverId = account.serverId;
        if (!serverId) {
          try {
            serverId = (await userWalletApi.add({
              name: account.name,
              publicKey: account.publicKey,
              ...(await serverKeyCopy(account.encryptedSecret)),
              network: get().network,
            })).id;
          } catch (err) {
            console.error("Failed to sync wallet to server:", err); // syncFromServer picks it up later; never trap the person here
          }
        }
        set((state) => ({ accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, serverId, backupPending: undefined } : a)) }));
      },

      // ─── Switch ───────────────────────────────
      switchAccount: (accountId) => {
        const account = get().accounts.find((a) => a.id === accountId);
        if (!account) throw new Error("Account not found");

        if (account.serverId) {
          userWalletApi.activate(account.serverId).catch(console.error);
        }

        set({
          activeAccountId: accountId,
          isUnlocked: false,
          _secretKey: null,
          _mnemonic: null,
          needsPassphraseUpgrade: false,
        });
      },

      // ─── Remove ───────────────────────────────
      removeAccount: (accountId) => {
        const { accounts, activeAccountId } = get();
        const account = accounts.find((a) => a.id === accountId);
        if (account?.serverId) {
          userWalletApi.remove(account.serverId).catch(console.error);
        }
        // Clean up stored mnemonic and the encrypted key kept in IndexedDB
        if (account) {
          localStorage.removeItem(`mnemonic_${account.publicKey}`);
          deleteStellarSecret(account.publicKey).catch(() => {});
        }
        const remaining = accounts.filter((a) => a.id !== accountId);
        let newActiveId = activeAccountId;
        if (activeAccountId === accountId) {
          newActiveId = remaining.length > 0 ? remaining[0].id : null;
        }
        set({ accounts: remaining, activeAccountId: newActiveId, isUnlocked: false, _secretKey: null, _mnemonic: null, needsPassphraseUpgrade: false });
      },

      removeLocalKey: async (accountId, expectedPublicKey) => {
        const account = get().accounts.find((a) => a.id === accountId);
        if (!account || account.publicKey !== expectedPublicKey) throw new Error("That wallet changed, so nothing was removed.");
        await deleteStellarSecret(account.publicKey);
        localStorage.removeItem(`mnemonic_${account.publicKey}`);
        const wasActive = get().activeAccountId === accountId;
        set((state) => ({
          accounts: state.accounts.map((a) => (a.id === accountId ? { ...a, encryptedSecret: "" } : a)),
          // Only lock when the unlocked wallet is the one that lost its key.
          ...(wasActive ? { isUnlocked: false, _secretKey: null, _mnemonic: null, needsPassphraseUpgrade: false } : {}),
        }));
      },

      // ─── Rename ───────────────────────────────
      renameAccount: (accountId, newName) => {
        const account = get().accounts.find((a) => a.id === accountId);
        if (account?.serverId) {
          userWalletApi.rename(account.serverId, newName).catch(console.error);
        }
        set((state) => ({
          accounts: state.accounts.map((a) =>
            a.id === accountId ? { ...a, name: newName } : a
          ),
        }));
      },

      // ─── Auth ─────────────────────────────────
      unlock: async (pin) => {
        const account = get().activeAccount();
        if (!account) throw new Error("No active account");
        let encryptedSecret = account.encryptedSecret;
        if (!encryptedSecret) {
          // After a reload the key comes from IndexedDB; restoring may still be running.
          encryptedSecret = (await loadStellarSecret(account.publicKey)) ?? "";
          if (!encryptedSecret) throw new Error("This browser has no copy of this wallet's key. Restore it with your recovery phrase or secret key.");
          set((state) => ({ accounts: state.accounts.map((a) => (a.id === account.id ? { ...a, encryptedSecret } : a)) }));
        }
        const secretKey = await decryptSecret(encryptedSecret, pin);

        // Also try to decrypt mnemonic if HD wallet
        let mnemonic: string | null = null;
        if (account.isHD) {
          const encMnemonic = localStorage.getItem(`mnemonic_${account.publicKey}`);
          if (encMnemonic) {
            try {
              mnemonic = await decryptSecret(encMnemonic, pin);
            } catch { /* an unreadable legacy phrase does not block unlock */ }
          }
        }

        // A correct legacy PIN no longer opens the wallet for signing: it may only move the wallet into the Amma account (lib/pin-retire.ts).
        if (isLegacyPin(pin)) {
          set({ isUnlocked: false, _secretKey: null, _mnemonic: null, needsPassphraseUpgrade: true });
          throw Object.assign(new Error(PIN_RETIRED_MESSAGE), { code: PIN_RETIRED_CODE });
        }
        set({ isUnlocked: true, _secretKey: secretKey, _mnemonic: mnemonic, needsPassphraseUpgrade: false });
      },

      changePassphrase: async (current, next) => {
        const problem = passphraseProblem(next);
        if (problem) throw new Error(problem);
        if (next === current) throw new Error("Choose a different passphrase from the current one.");
        const active = get().activeAccount();
        if (!active) throw new Error("No active account");

        // Work out every new copy first; nothing is written until all of them exist.
        const accounts = get().accounts;
        const old = new Map<string, string>();
        const fresh = new Map<string, string>();
        for (const a of accounts) {
          const encrypted = a.encryptedSecret || (await loadStellarSecret(a.publicKey)) || "";
          if (!encrypted) continue;
          let secret: string;
          try {
            secret = await decryptSecret(encrypted, current);
          } catch {
            continue; // locked with a different passphrase: not ours to change
          }
          old.set(a.publicKey, encrypted);
          fresh.set(a.publicKey, await encryptSecret(secret, next));
        }
        if (!fresh.has(active.publicKey)) throw new Error("Wrong passphrase.");

        // Write the browser key store; any failure puts the old copies back.
        const written: string[] = [];
        const putBack = async () => {
          for (const publicKey of written) await saveStellarSecret(publicKey, old.get(publicKey)!).catch(() => {});
        };
        try {
          for (const [publicKey, encrypted] of fresh) {
            await saveStellarSecret(publicKey, encrypted);
            written.push(publicKey);
          }
        } catch {
          await putBack();
          throw new Error("This browser could not save the new passphrase. Nothing was changed; try again.");
        }
        // Delegated signing: the server re-encrypts its own copy, proven by the current passphrase.
        // If it refuses, this device goes back to the old passphrase too, so the two stay in step.
        if ((await signingMode()) === "delegated") {
          try {
            await userWalletApi.changeDelegatedPassphrase(current, next);
          } catch (err) {
            await putBack();
            throw err;
          }
        }
        set((state) => ({
          accounts: state.accounts.map((a) => (fresh.has(a.publicKey) ? { ...a, encryptedSecret: fresh.get(a.publicKey)! } : a)),
          needsPassphraseUpgrade: false,
        }));
        return fresh.size;
      },

      restoreFromServerBackup: async (passphrase) => {
        const active = get().activeAccount();
        if (!active) throw new Error("No active account");
        if (!active.serverId) throw new Error("This wallet is not linked to your Amma account yet. Sign in again and retry.");
        if (active.encryptedSecret || (await loadStellarSecret(active.publicKey))) {
          throw new Error("This browser already has this wallet's key.");
        }
        let copy: string;
        try {
          copy = (await userWalletApi.getKeyBackup(active.serverId)).encryptedSecret;
        } catch (err) {
          throw new Error((err as Error)?.message || "Could not get the backup from Amma. Try again in a moment.");
        }
        let secretKey: string;
        try {
          secretKey = await decryptSecret(copy, passphrase);
        } catch {
          throw new Error("That is not the passphrase this wallet was created with. Use the one from the device that made it.");
        }
        if (keypairFromSecret(secretKey).publicKey !== active.publicKey) {
          throw new Error("The stored key does not match this wallet's address, so it was not restored.");
        }
        await saveStellarSecret(active.publicKey, copy);
        // Restored under a legacy PIN: kept, but not opened for signing; the PIN may only move it into the Amma account.
        const retired = isLegacyPin(passphrase);
        set((state) => ({
          accounts: state.accounts.map((a) => (a.id === active.id ? { ...a, encryptedSecret: copy } : a)),
          isUnlocked: !retired,
          _secretKey: retired ? null : secretKey,
          needsPassphraseUpgrade: retired,
        }));
      },

      resetPassphraseFromPhrase: async (rawPhrase, newPassphrase) => {
        const problem = passphraseProblem(newPassphrase);
        if (problem) throw new Error(problem);
        const phrase = normalizeMnemonic(rawPhrase);
        if (!isValidMnemonic(phrase)) throw new Error("That is not a valid recovery phrase.");

        // Which of this device's wallets does the phrase own? Scan the first accounts it can derive.
        const owned = new Map<string, string>();
        for (let i = 0; i < 20; i++) {
          const k = deriveHDKeypair(phrase, i);
          owned.set(k.publicKey, k.secretKey);
        }
        const matches = get().accounts.filter((a) => owned.has(a.publicKey));
        if (matches.length === 0) {
          // A new device: the phrase becomes this device's first wallet.
          await get().importFromMnemonic("Recovered wallet", phrase, newPassphrase);
          return { updated: 1, serverSynced: true };
        }

        // Work out every new copy first; nothing is written until all of them exist.
        const fresh = new Map<string, string>();
        for (const a of matches) fresh.set(a.publicKey, await encryptSecret(owned.get(a.publicKey)!, newPassphrase));
        for (const [publicKey, encrypted] of fresh) await saveStellarSecret(publicKey, encrypted);

        let serverSynced = true;
        if ((await signingMode()) === "delegated") {
          for (const a of matches) {
            if (!a.serverId) continue;
            try { await userWalletApi.updateSecret(a.serverId, fresh.get(a.publicKey)!); } catch { serverSynced = false; }
          }
        }
        const active = get().activeAccount();
        const unlockKey = active && owned.has(active.publicKey) ? owned.get(active.publicKey)! : owned.get(matches[0].publicKey)!;
        set((state) => ({
          accounts: state.accounts.map((a) => (fresh.has(a.publicKey) ? { ...a, encryptedSecret: fresh.get(a.publicKey)! } : a)),
          activeAccountId: active && owned.has(active.publicKey) ? state.activeAccountId : matches[0].id,
          isUnlocked: true,
          _secretKey: unlockKey,
          _mnemonic: phrase,
          needsPassphraseUpgrade: false,
        }));
        return { updated: matches.length, serverSynced };
      },

      backupRecoveryPhrase: async (phrase) => {
        try {
          const clean = normalizeMnemonic(phrase);
          if (!isValidMnemonic(clean)) return "failed";
          const status = await keyEscrowApi.status();
          if (!status.enabled) return "off";
          if ((await signingMode()) !== "delegated") return "self-custody";
          await keyEscrowApi.savePhrase(clean);
          return "saved";
        } catch {
          // Deliberately silent: the error text could carry request details. The caller shows its own message.
          return "failed";
        }
      },

      uploadKeysForDelegatedSigning: async () => {
        const { accounts } = get();
        const active = get().activeAccount();
        if (!active) throw new Error("No active account");
        const withKey = await Promise.all(
          accounts.map(async (a) => ({ ...a, encryptedSecret: a.encryptedSecret || ((await loadStellarSecret(a.publicKey)) ?? "") })),
        );
        const activeWithKey = withKey.find((a) => a.id === active.id)!;
        if (!activeWithKey.encryptedSecret) {
          throw new Error("This browser has no copy of the active wallet's key. Restore it with your recovery phrase or secret key first.");
        }
        // Check everything before sending anything, so a refusal leaves no copy behind.
        if (!activeWithKey.serverId) {
          throw new Error("The active wallet is not registered with Amma yet. Sign in again and retry.");
        }
        // Delegated signing uses the server's active wallet: make it this one first.
        await userWalletApi.activate(activeWithKey.serverId);
        await userWalletApi.updateSecret(activeWithKey.serverId, activeWithKey.encryptedSecret);
        for (const a of withKey) {
          if (a.id !== active.id && a.serverId && a.encryptedSecret) await userWalletApi.updateSecret(a.serverId, a.encryptedSecret);
        }
      },

      removeServerKeyCopy: async () => {
        const account = get().activeAccount();
        // Unlocking proved this device holds a working copy; only then is the server copy redundant.
        if (!account || !get().isUnlocked || !get()._secretKey || !account.encryptedSecret) throw new Error("Unlock the wallet first");
        if ((await signingMode()) !== "self") throw new Error("Delegated signing uses the server copy. Switch to self-custody first.");
        if (!account.serverId) throw new Error("This wallet is not registered with Amma.");
        await userWalletApi.removeSecret(account.serverId);
        set((state) => ({ accounts: state.accounts.map((a) => (a.id === account.id ? { ...a, hasServerKey: false } : a)) }));
      },

      dismissPassphraseUpgrade: () => set({ needsPassphraseUpgrade: false }),

      lock: () => set({ isUnlocked: false, _secretKey: null, _mnemonic: null, needsPassphraseUpgrade: false }),

      logout: () => {
        // Clean up all mnemonics
        const accounts = get().accounts;
        for (const acc of accounts) {
          localStorage.removeItem(`mnemonic_${acc.publicKey}`);
        }
        set({
          accounts: [],
          activeAccountId: null,
          ownerId: null,
          isUnlocked: false,
          _secretKey: null,
          _mnemonic: null,
          needsPassphraseUpgrade: false,
        });
      },

      getSecretKey: () => {
        const sk = get()._secretKey;
        if (!sk) throw new Error("Wallet is locked");
        return sk;
      },

      getMnemonic: () => {
        return get()._mnemonic;
      },

      setNetwork: (n) => set({ network: n }),
    }),
    {
      name: "amma-wallet",
      partialize: (state) => ({
        accounts: state.accounts.map(({ encryptedSecret, ...rest }) => rest),
        activeAccountId: state.activeAccountId,
        storagePersisted: state.storagePersisted,
        ownerId: state.ownerId,
        setAside: state.setAside, // held without keys (see claimFor)
        // network is intentionally NOT persisted — always starts from default ("public")
        // to prevent stale testnet values from localStorage affecting mainnet wallet creation
      }),
      // Encrypted keys are kept out of localStorage; put them back from IndexedDB.
      onRehydrateStorage: () => (state) => {
        setStellarKeystoreOwner(state?.ownerId ?? null);
        void restoreSecretsFromKeystore();
      },
    }
  )
);

// Another tab signed in as someone else: take its list, drop our decrypted key.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== "amma-wallet" && event.key !== null) return;
    const raw = localStorage.getItem("amma-wallet");
    let stored: number | null;
    try { stored = JSON.parse(raw ?? "null")?.state?.ownerId ?? null; } catch { return; }
    if (stored === (useWalletStore.getState().ownerId ?? null)) return;
    useWalletStore.getState().lock(); // this write also persists our own state, so put the other tab's back
    if (raw) localStorage.setItem("amma-wallet", raw);
    void useWalletStore.persist.rehydrate();
  });
}

/** Fill in encrypted keys that localStorage does not hold (see partialize). */
async function restoreSecretsFromKeystore(): Promise<void> {
  const stored = await loadAllStellarSecrets();
  if (stored.size === 0) return;
  useWalletStore.setState((state) => ({
    accounts: state.accounts.map((a) => (a.encryptedSecret ? a : { ...a, encryptedSecret: stored.get(a.publicKey) ?? "" })),
  }));
}

// Every new or re-encrypted key is written to IndexedDB, whichever action made it.
useWalletStore.subscribe((state, prev) => {
  if (state.accounts === prev.accounts) return;
  for (const account of state.accounts) {
    const before = prev.accounts.find((p) => p.publicKey === account.publicKey);
    if (account.encryptedSecret && account.encryptedSecret !== before?.encryptedSecret) {
      saveStellarSecret(account.publicKey, account.encryptedSecret).catch(() => {});
    }
  }
});
