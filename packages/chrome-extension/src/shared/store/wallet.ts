import { create } from "zustand";
import { persist } from "zustand/middleware";
import { NETWORK_LOCK, effectiveNetwork, type NetworkLock } from "../lib/network-lock";
import { generateKeypair, keypairFromSecret, fundTestnet } from "../lib/stellar";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { userWalletApi, signingApi } from "../lib/api";
import { deriveHDKeypair, isValidMnemonic, normalizeMnemonic } from "../lib/hd-wallet";
import { AMMA_HELD_MESSAGE, isLegacyPin, moveLegacyPinWallet, PIN_RETIRED_CODE, PIN_RETIRED_MESSAGE } from "../lib/pin-retire";

export interface WalletAccount {
  id: string;
  serverId?: number;
  name: string;
  publicKey: string;
  encryptedSecret: string;
  isHD?: boolean;
  derivationIndex?: number;
  createdAt: number;
}

/** Loading saved state: a network the lock does not allow becomes testnet (G-09). */
export function mergePersistedWallet<T extends { network: "testnet" | "public" }>(
  persisted: Partial<T> | undefined,
  current: T,
  lock: NetworkLock = NETWORK_LOCK
): T {
  const saved = (persisted ?? {}) as Partial<T>;
  return { ...current, ...saved, network: effectiveNetwork(saved.network, lock) };
}

interface WalletState {
  accounts: WalletAccount[];
  activeAccountId: string | null;
  network: "testnet" | "public";
  isUnlocked: boolean;
  _secretKey: string | null;
  _mnemonic: string | null;
  _syncing: boolean;
  /** The active wallet was opened with a retired short passphrase: the move-to-Amma dialog is showing (lib/pin-retire.ts). */
  pinRetired: boolean;
  /** Opens the key with the retired passphrase and moves it into the Amma account with the login password. */
  retireLegacyPin: (pin: string, password: string) => Promise<"moved" | "paused">;
  dismissPinRetired: () => void;

  getPublicKey: () => string | null;
  activeAccount: () => WalletAccount | null;
  createWallet: (name: string, pin: string) => Promise<string>;
  importWallet: (name: string, secretKey: string, pin: string) => Promise<string>;
  generateMnemonic: () => Promise<string>;
  /** Before enabling delegated signing: send this device's encrypted keys to the server. */
  uploadKeysForDelegatedSigning: () => Promise<void>;
  createWalletFromMnemonic: (
    name: string,
    mnemonic: string,
    pin: string
  ) => Promise<{ publicKey: string; mnemonic: string }>;
  importFromMnemonic: (name: string, mnemonic: string, pin: string) => Promise<string>;
  switchAccount: (accountId: string) => void;
  removeAccount: (accountId: string) => void;
  renameAccount: (accountId: string, newName: string) => void;
  unlock: (pin: string) => Promise<void>;
  lock: () => void;
  logout: (keepKeys?: boolean) => void;
  ownerId: number | null;
  /** Local wallets of other people who used this browser. They are set aside, never deleted. */
  setAside: Record<string, { accounts: WalletAccount[]; activeAccountId: string | null }>;
  claimFor: (userId: number) => void;
  removeWalletsFromBrowser: () => void;
  getSecretKey: () => string;
  setNetwork: (n: "testnet" | "public") => void;
  syncFromServer: () => Promise<void>;
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

/** Audit F-1 / TODO D1: self-custody keys stay on this device; only delegated signing sends a copy. */
async function serverKeyCopy(encrypted: string): Promise<{ encryptedSecret?: string }> {
  return (await signingMode()) === "delegated" ? { encryptedSecret: encrypted } : {};
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      accounts: [],
      activeAccountId: null,
      network: "testnet",
      isUnlocked: false,
      _secretKey: null,
      _mnemonic: null,
      _syncing: false,
      pinRetired: false,
      ownerId: null,
      setAside: {},

      getPublicKey: () => {
        const state = get();
        const active = state.accounts.find((a) => a.id === state.activeAccountId);
        return active?.publicKey ?? null;
      },

      activeAccount: () => {
        const state = get();
        return state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
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
              encryptedSecret:
                local.encryptedSecret, // keys never come from the server (D1)
            });
            seenPubkeys.add(local.publicKey);
          }

          for (const sw of serverWallets) {
            if (!seenPubkeys.has(sw.publicKey)) {
              merged.push({
                id: generateId(),
                serverId: sw.id,
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

          if (
            !currentActiveId ||
            !merged.find((m) => m.id === currentActiveId)
          ) {
            if (activeServer) {
              const match = merged.find(
                (m) => m.publicKey === activeServer.publicKey
              );
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

      createWallet: async (name, pin) => {
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

        const { publicKey, secretKey } = generateKeypair();
        const encrypted = await encryptSecret(secretKey, pin);

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
            throw new Error("A wallet with this name already exists");
          }
          console.error("Failed to sync wallet to server:", err);
        }

        try {
          await fundTestnet(publicKey);
        } catch {}

        const account: WalletAccount = {
          id: generateId(),
          serverId,
          name: trimmedName,
          publicKey,
          encryptedSecret: encrypted,
          createdAt: Date.now(),
        };

        set((state) => ({
          accounts: [...state.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
        }));

        return publicKey;
      },

      importWallet: async (name, secretKey, pin) => {
        const trimmedName = (
          name || `Imported ${get().accounts.length + 1}`
        ).trim();
        if (
          get().accounts.some(
            (a) => a.name.toLowerCase() === trimmedName.toLowerCase()
          )
        ) {
          throw new Error("A wallet with this name already exists");
        }

        const { publicKey } = keypairFromSecret(secretKey);

        if (get().accounts.some((a) => a.publicKey === publicKey)) {
          throw new Error("This wallet is already added");
        }

        const encrypted = await encryptSecret(secretKey, pin);

        const account: WalletAccount = {
          id: generateId(),
          name: trimmedName,
          publicKey,
          encryptedSecret: encrypted,
          createdAt: Date.now(),
        };

        try {
          const serverWallet = await userWalletApi.add({
            name: trimmedName,
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
        }));

        return publicKey;
      },

      uploadKeysForDelegatedSigning: async () => {
        const active = get().activeAccount();
        if (!active?.encryptedSecret) {
          throw new Error("This device has no copy of the active wallet's key. Restore it with your recovery phrase or secret key first.");
        }
        // Check everything before sending anything, so a refusal leaves no copy behind.
        if (!active.serverId) {
          throw new Error("The active wallet is not registered with Amma yet. Sign in again and retry.");
        }
        // Delegated signing uses the server's active wallet: make it this one first.
        await userWalletApi.activate(active.serverId);
        await userWalletApi.updateSecret(active.serverId, active.encryptedSecret);
        for (const a of get().accounts) {
          if (a.id !== active.id && a.serverId && a.encryptedSecret) await userWalletApi.updateSecret(a.serverId, a.encryptedSecret);
        }
      },

      // ─── Mnemonic support ──────────────────────────────────
      generateMnemonic: async () => {
        // The popup tells people to write down 24 words, so generate 24 (256-bit).
        const { generateRecoveryPhrase } = await import("../lib/hd-wallet");
        return generateRecoveryPhrase(24);
      },

      createWalletFromMnemonic: async (name, rawMnemonic, pin) => {
        const mnemonic = normalizeMnemonic(rawMnemonic);
        const trimmedName = (
          name || `HD Wallet ${get().accounts.length + 1}`
        ).trim();
        if (
          get().accounts.some(
            (a) => a.name.toLowerCase() === trimmedName.toLowerCase()
          )
        ) {
          throw new Error("A wallet with this name already exists");
        }

        // Derive on this device: the recovery phrase is never sent to the server.
        const derived = deriveHDKeypair(mnemonic, 0);
        const { publicKey, secretKey } = derived;

        if (get().accounts.some((a) => a.publicKey === publicKey)) {
          throw new Error("This wallet is already added");
        }

        const encrypted = await encryptSecret(secretKey, pin);
        const encryptedMnemonic = await encryptSecret(mnemonic, pin);

        // Store encrypted mnemonic in localStorage
        const accountId = generateId();
        localStorage.setItem(`mnemonic_${accountId}`, encryptedMnemonic);

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
            throw new Error("A wallet with this name already exists");
          }
          console.error("Failed to sync wallet to server:", err);
        }

        try {
          await fundTestnet(publicKey);
        } catch {}

        const account: WalletAccount = {
          id: accountId,
          serverId,
          name: trimmedName,
          publicKey,
          encryptedSecret: encrypted,
          isHD: true,
          derivationIndex: 0,
          createdAt: Date.now(),
        };

        set((state) => ({
          accounts: [...state.accounts, account],
          activeAccountId: account.id,
          isUnlocked: true,
          _secretKey: secretKey,
          _mnemonic: mnemonic,
        }));

        return { publicKey, mnemonic };
      },

      importFromMnemonic: async (name, rawMnemonic, pin) => {
        const mnemonic = normalizeMnemonic(rawMnemonic);
        const trimmedName = (
          name || `Recovered ${get().accounts.length + 1}`
        ).trim();
        if (
          get().accounts.some(
            (a) => a.name.toLowerCase() === trimmedName.toLowerCase()
          )
        ) {
          throw new Error("A wallet with this name already exists");
        }

        // Validate and derive on this device: the recovery phrase is never sent to the server.
        if (!isValidMnemonic(mnemonic)) {
          throw new Error("Invalid recovery phrase");
        }

        const derived = deriveHDKeypair(mnemonic, 0);
        const { publicKey, secretKey } = derived;

        if (get().accounts.some((a) => a.publicKey === publicKey)) {
          throw new Error("This wallet is already added");
        }

        const encrypted = await encryptSecret(secretKey, pin);
        const encryptedMnemonic = await encryptSecret(mnemonic, pin);

        const accountId = generateId();
        localStorage.setItem(`mnemonic_${accountId}`, encryptedMnemonic);

        const account: WalletAccount = {
          id: accountId,
          name: trimmedName,
          publicKey,
          encryptedSecret: encrypted,
          isHD: true,
          derivationIndex: 0,
          createdAt: Date.now(),
        };

        try {
          const serverWallet = await userWalletApi.add({
            name: trimmedName,
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
          _mnemonic: mnemonic,
        }));

        return publicKey;
      },

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
        });
      },

      removeAccount: (accountId) => {
        const { accounts, activeAccountId } = get();
        const account = accounts.find((a) => a.id === accountId);
        if (account?.serverId) {
          userWalletApi.remove(account.serverId).catch(console.error);
        }
        // Clean up mnemonic
        localStorage.removeItem(`mnemonic_${accountId}`);

        const remaining = accounts.filter((a) => a.id !== accountId);
        let newActiveId = activeAccountId;
        if (activeAccountId === accountId) {
          newActiveId = remaining.length > 0 ? remaining[0].id : null;
        }
        set({
          accounts: remaining,
          activeAccountId: newActiveId,
          isUnlocked: false,
          _secretKey: null,
          _mnemonic: null,
        });
      },

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

      unlock: async (pin) => {
        const account = get().activeAccount();
        if (!account) throw new Error("No active account");
        // Moved into the Amma account: there is no key on this device any more.
        if (!account.encryptedSecret) throw new Error(AMMA_HELD_MESSAGE);
        const secretKey = await decryptSecret(account.encryptedSecret, pin);
        // A correct retired short passphrase never opens the wallet for signing: it may only move it (lib/pin-retire.ts).
        if (isLegacyPin(pin)) {
          set({ isUnlocked: false, _secretKey: null, _mnemonic: null, pinRetired: true });
          throw Object.assign(new Error(PIN_RETIRED_MESSAGE), { code: PIN_RETIRED_CODE });
        }

        // Also decrypt mnemonic if HD wallet
        let mnemonic: string | null = null;
        if (account.isHD) {
          const encryptedMnemonic = localStorage.getItem(
            `mnemonic_${account.id}`
          );
          if (encryptedMnemonic) {
            try {
              mnemonic = await decryptSecret(encryptedMnemonic, pin);
            } catch {
              // Mnemonic decrypt failed, not critical
            }
          }
        }

        set({ isUnlocked: true, _secretKey: secretKey, _mnemonic: mnemonic });
      },

      lock: () =>
        set({ isUnlocked: false, _secretKey: null, _mnemonic: null }),

      dismissPinRetired: () => set({ pinRetired: false }),

      retireLegacyPin: async (pin, password) => {
        const account = get().activeAccount();
        if (!account?.encryptedSecret) throw new Error("No wallet key on this device to move.");
        let secret: string;
        try {
          secret = await decryptSecret(account.encryptedSecret, pin);
        } catch {
          throw new Error("That wallet passphrase is not correct.");
        }
        // Prefer the recovery phrase when this device has it, so Amma holds the whole HD wallet.
        const sealed = account.isHD ? localStorage.getItem(`mnemonic_${account.id}`) : null;
        if (sealed) {
          try {
            const phrase = await decryptSecret(sealed, pin);
            if (deriveHDKeypair(phrase, account.derivationIndex ?? 0).publicKey === account.publicKey) secret = phrase;
          } catch { /* the secret key is just as good */ }
        }
        const { useAuthStore } = await import("./auth");
        const selfCustody = useAuthStore.getState().signingMode === "self";
        const outcome = await moveLegacyPinWallet({ address: account.publicKey, secret, password, selfCustody, name: account.name });
        secret = "";
        if (outcome === "moved") {
          // Verified by the server: the PIN-encrypted copy on this device goes.
          localStorage.removeItem(`mnemonic_${account.id}`);
          set((state) => ({
            accounts: state.accounts.map((a) => (a.id === account.id ? { ...a, encryptedSecret: "" } : a)),
            isUnlocked: false, _secretKey: null, _mnemonic: null, pinRetired: false,
          }));
          if (selfCustody) useAuthStore.setState({ signingMode: "delegated" });
        } else {
          set({ pinRetired: false });
        }
        return outcome;
      },

      // Sign out. With keepKeys the encrypted accounts and the encrypted recovery phrase stay on
      // this device (self-custody: they are the only copy). Otherwise Amma holds the keys.
      logout: (keepKeys = false) => {
        if (keepKeys) {
          set({ isUnlocked: false, _secretKey: null, _mnemonic: null });
          return;
        }
        for (const account of get().accounts) {
          localStorage.removeItem(`mnemonic_${account.id}`);
        }
        set({
          accounts: [],
          activeAccountId: null,
          isUnlocked: false,
          _secretKey: null,
          _mnemonic: null,
          ownerId: null,
        });
      },

      // Wallets kept on this device belong to one person. Someone else signing in starts clean,
      // and the first person's wallets are set aside, not deleted: they may be the only copy.
      claimFor: (userId) => {
        const owner = get().ownerId;
        if (owner !== null && owner !== userId) {
          const setAside = { ...get().setAside };
          if (get().accounts.length > 0) {
            setAside[String(owner)] = { accounts: get().accounts, activeAccountId: get().activeAccountId };
          }
          const returning = setAside[String(userId)];
          delete setAside[String(userId)];
          set({
            accounts: returning?.accounts ?? [],
            activeAccountId: returning?.activeAccountId ?? null,
            setAside,
            isUnlocked: false,
            _secretKey: null,
            _mnemonic: null,
            ownerId: userId,
          });
          return;
        }
        set({ ownerId: userId });
      },

      // The only action that erases self-custody keys from this browser on request.
      removeWalletsFromBrowser: () => {
        for (const account of get().accounts) localStorage.removeItem(`mnemonic_${account.id}`);
        set({ accounts: [], activeAccountId: null, isUnlocked: false, _secretKey: null, _mnemonic: null, ownerId: null });
      },

      getSecretKey: () => {
        const sk = get()._secretKey;
        if (!sk) throw new Error("Wallet is locked");
        return sk;
      },

      setNetwork: (n) => set({ network: effectiveNetwork(n, NETWORK_LOCK) }),
    }),
    {
      name: "amma-wallet",
      partialize: (state) => ({
        accounts: state.accounts,
        activeAccountId: state.activeAccountId,
        network: state.network,
        ownerId: state.ownerId,
        setAside: state.setAside,
      }),
      // A Mainnet value saved by an older build becomes testnet in a locked build, on load, not only on switch.
      merge: (persisted, current) => mergePersistedWallet(persisted as Partial<WalletState> | undefined, current),
    }
  )
);
