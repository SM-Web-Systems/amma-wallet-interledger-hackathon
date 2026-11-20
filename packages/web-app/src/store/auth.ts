import { create } from "zustand";
import { persist } from "zustand/middleware";
import { authApi, setTokens, clearTokens, getAccessToken, restoreSession, userWalletApi, signingApi } from "../lib/api";
import { useWalletStore } from "./wallet";
import { ensureCustodyWallets } from "../lib/custody-onboard";

export interface User {
  id: number;
  email: string | null;
  pendingEmail?: string | null;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  preferredLanguage: string;
  preferredNetwork: string;
  isEmailVerified?: boolean;
}

export interface ServerWallet {
  id: number;
  name: string;
  publicKey: string;
  network: string;
  isActive: boolean;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  serverWallets: ServerWallet[];
  signingMode: "self" | "delegated";

  register: (email: string, password: string, firstName?: string, lastName?: string, turnstileToken?: string) => Promise<void>;
  login: (email: string, password: string, turnstileToken?: string, twoFaToken?: string) => Promise<void>;
  logout: () => Promise<void>;
  loadProfile: () => Promise<void>;
  updateProfile: (data: { firstName?: string; lastName?: string; preferredLanguage?: string; preferredNetwork?: string }) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;

  loadWallets: () => Promise<void>;
  addWallet: (data: { name: string; publicKey: string; encryptedSecret?: string; network?: string }) => Promise<void>;
  activateWallet: (id: number) => Promise<void>;
  renameWallet: (id: number, name: string) => Promise<void>;
  removeWallet: (id: number) => Promise<void>;
}

async function fetchSigningMode(): Promise<"self" | "delegated"> {
  try {
    const mode = await signingApi.getMode();
    return mode;
  } catch {
    return "self";
  }
}

/**
 * After the tokens are set: bind the wallet list to this user, set up Amma-held wallets (bounded, never throws),
 * then load and sync wallets. Runs before isAuthenticated flips, so AuthRoute and ProtectedRoute already see
 * the Amma Stellar wallet and never race to device-wallet onboarding (WA-06).
 */
async function loadWalletsAfterSignIn(userId: number, loadWallets: () => Promise<void>, serverKeys: () => string[]): Promise<void> {
  // Bind the wallet list to this user first, so no render shows the previous owner's wallets.
  useWalletStore.getState().claimFor(userId, []);
  await ensureCustodyWallets();
  await loadWallets();
  useWalletStore.getState().claimFor(userId, serverKeys());
  await useWalletStore.getState().syncFromServer();
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      serverWallets: [],
      signingMode: "self",

      register: async (email, password, firstName, lastName, turnstileToken) => {
        set({ isLoading: true });
        try {
          const res = await authApi.register({ email, password, firstName, lastName, turnstileToken });
          setTokens(res.accessToken, res.refreshToken);
          const mode = await fetchSigningMode();
          await loadWalletsAfterSignIn(res.user.id, get().loadWallets, () => get().serverWallets.map((w) => w.publicKey));
          set({
            user: res.user,
            isAuthenticated: true,
            isLoading: false,
            signingMode: mode,
          });
        } catch (err) {
          set({ isLoading: false });
          throw err;
        }
      },

      login: async (email, password, turnstileToken, twoFaToken?) => {
        set({ isLoading: true });
        try {
          const identifier = email.trim();
          const res = await authApi.login({ ...(identifier.startsWith('+') ? {phoneNumber: identifier} : {email: identifier}), password, turnstileToken, twoFaToken });

          // If 2FA is required, throw so the UI can prompt for the code
          if (res.twoFaRequired) {
            set({ isLoading: false });
            throw new Error("2FA_REQUIRED:" + (res.twoFaMethod || "totp"));
          }

          setTokens(res.accessToken, res.refreshToken);
          const mode = await fetchSigningMode();
          await loadWalletsAfterSignIn(res.user.id, get().loadWallets, () => get().serverWallets.map((w) => w.publicKey));
          set({
            user: res.user,
            isAuthenticated: true,
            isLoading: false,
            signingMode: mode,
          });
        } catch (err) {
          set({ isLoading: false });
          throw err;
        }
      },

      logout: async () => {
        try {
          await authApi.logout();
        } catch { /* sign out locally even if the server is unreachable */ }
        clearTokens();
        useWalletStore.getState().logout();
        set({
          user: null,
          isAuthenticated: false,
          serverWallets: [],
          signingMode: "self",
        });
      },

      loadProfile: async () => {
        // After a reload only the httpOnly refresh cookie survives; trade it for an access token.
        if (!getAccessToken() && !(get().isAuthenticated && await restoreSession())) {
          useWalletStore.getState().lock(); // a dropped session must not leave a decrypted key in memory
          set({ user: null, isAuthenticated: false, serverWallets: [], signingMode: "self" });
          return;
        }
        try {
          const res = await authApi.me();
          const {wallets: _wallets, ...profile} = res.user ?? res;
          const mode = await fetchSigningMode();
          useWalletStore.getState().claimFor(profile.id, (res.wallets || []).map((w: ServerWallet) => w.publicKey));
          set({
            user: profile,
            isAuthenticated: true,
            serverWallets: res.wallets || [],
            signingMode: mode,
          });
          await useWalletStore.getState().syncFromServer();
        } catch {
          clearTokens();
          useWalletStore.getState().lock();
          set({ user: null, isAuthenticated: false, serverWallets: [], signingMode: "self" });
        }
      },

      updateProfile: async (data) => {
        const res = await authApi.updateProfile(data);
        // Check if 2FA is required
        if ((res as any).twoFaRequired) {
          throw new Error("2FA_REQUIRED:" + (res.twoFaMethod || "totp"));
        }
        set({ user: {...get().user, ...(res.user ?? res)} });
      },

      changePassword: async (currentPassword, newPassword) => {
        await authApi.changePassword({ currentPassword, newPassword });
      },

      loadWallets: async () => {
        try {
          const wallets = await userWalletApi.list();
          set({ serverWallets: wallets });
        } catch { /* keep the last known list when offline */ }
      },

      addWallet: async (data) => {
        await userWalletApi.add(data);
        await get().loadWallets();
      },

      activateWallet: async (id) => {
        await userWalletApi.activate(id);
        await get().loadWallets();
      },

      renameWallet: async (id, name) => {
        await userWalletApi.rename(id, name);
        await get().loadWallets();
      },

      removeWallet: async (id) => {
        await userWalletApi.remove(id);
        await get().loadWallets();
      },
    }),
    {
      name: "amma-wallet-auth",
      partialize: (state) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
        serverWallets: state.serverWallets,
        signingMode: state.signingMode,
      }),
    }
  )
);
