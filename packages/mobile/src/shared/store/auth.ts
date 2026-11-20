import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useWalletStore } from "./wallet";
import { authApi } from "../lib/api";
import { API_BASE } from "../lib/config";


export interface UserProfile {
  id: number;
  email: string | null;
  phoneNumber: string | null;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  preferredLanguage: string;
  preferredNetwork: string;
}

interface AuthState {
  user: UserProfile | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  /** App lock. The wallet passphrase (wallet store vault, D8) is what unlocks it. */
  isLocked: boolean;

  register: (data: {
    email?: string;
    password: string;
    phoneNumber?: string;
    firstName?: string;
    lastName?: string;
  }, turnstileToken?: string) => Promise<void>;
  /** turnstileToken is the human-verification token; the 2FA step doesn't need one. */
  login: (identifier: string, password: string, twoFaToken?: string, turnstileToken?: string) => Promise<any>;
  logout: () => Promise<void>;
  loadProfile: () => Promise<void>;
  updateProfile: (data: Partial<UserProfile>) => Promise<void>;
  refreshSession: () => Promise<boolean>;

  lock: () => void;
  /** Called after the wallet store has checked the passphrase or biometrics. */
  setUnlocked: () => void;

  signingMode?: "self" | "delegated";
}

async function apiRequest(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Detect if identifier is a phone number (starts with +) or email
function isPhoneNumber(identifier: string): boolean {
  return identifier.startsWith("+");
}

type AuthGet = () => AuthState;
type AuthSet = (partial: Partial<AuthState>) => void;
let refreshInFlight: Promise<boolean> | null = null;

async function runRefresh(get: AuthGet, set: AuthSet): Promise<boolean> {
  const { refreshToken } = get();
  if (!refreshToken) return false;

  try {
    const data = await apiRequest("/api/v1/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
    set({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
    });
    return true;
  } catch {
    // Refused, but the stored token has moved on: another refresh finished first. Stay signed in.
    if (get().refreshToken && get().refreshToken !== refreshToken) return true;
    set({
      isAuthenticated: false,
      accessToken: null,
      refreshToken: null,
      user: null,
    });
    return false;
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLocked: true,

      register: async (data, turnstileToken) => {
        const res = await apiRequest("/api/v1/auth/register", {
          method: "POST",
          body: JSON.stringify(turnstileToken ? { ...data, turnstileToken } : data),
        });
        set({
          user: res.user,
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          isAuthenticated: true,
          isLocked: false,
        });
      },

      login: async (identifier, password, twoFaToken, turnstileToken) => {
        const body: Record<string, string> = { password };

        if (isPhoneNumber(identifier)) {
          body.phoneNumber = identifier;
        } else {
          body.email = identifier;
        }

        if (twoFaToken) {
          body.twoFaToken = twoFaToken;
        } else if (turnstileToken) {
          body.turnstileToken = turnstileToken;
        }

        const data = await apiRequest("/api/v1/auth/login", {
          method: "POST",
          body: JSON.stringify(body),
        });

        // If 2FA is required, return the response so the UI can prompt
        if (data.twoFaRequired) {
          return data;
        }

        set({
          user: data.user,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          isAuthenticated: true,
          isLocked: true, // the wallet passphrase unlocks the app (D8)
        });

        // Sync wallets from server
        await useWalletStore.getState().syncFromServer(data.accessToken);

        return data;
      },

      logout: async () => {
        const { refreshToken } = get();
        try {
          if (refreshToken) {
            await apiRequest("/api/v1/auth/logout", {
              method: "POST",
              body: JSON.stringify({ refreshToken }),
            });
          }
        } catch {}
        useWalletStore.getState().logout();
        set({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          isLocked: true,
        });
      },

      loadProfile: async () => {
        const { accessToken, refreshSession } = get();
        if (!accessToken) return;

        try {
          const data = await apiRequest("/api/v1/auth/me", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          let signingMode: "self" | "delegated" = "self";
          try {
            const modeRes = await apiRequest("/api/v1/user/signing-mode", {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            signingMode = modeRes.signingMode || "self";
          } catch {}
          set({ user: data, isAuthenticated: true, signingMode });
          await useWalletStore.getState().syncFromServer(accessToken);
        } catch {
          const refreshed = await refreshSession();
          if (refreshed) {
            try {
              const token = get().accessToken!;
              const data = await apiRequest("/api/v1/auth/me", {
                headers: { Authorization: `Bearer ${token}` },
              });
              let signingMode: "self" | "delegated" = "self";
              try {
                const modeRes = await apiRequest("/api/v1/user/signing-mode", {
                  headers: { Authorization: `Bearer ${token}` },
                });
                signingMode = modeRes.signingMode || "self";
              } catch {}
              set({ user: data, isAuthenticated: true, signingMode });
              await useWalletStore.getState().syncFromServer(token);
            } catch {
              set({ isAuthenticated: false, accessToken: null, refreshToken: null, user: null });
            }
          }
        }
      },

      updateProfile: async (updates) => {
        const { accessToken } = get();
        const data = await apiRequest("/api/v1/auth/profile", {
          method: "PATCH",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify(updates),
        });
        set({ user: { ...get().user!, ...data } });
      },

      refreshSession: () => {
        // The server rotates refresh tokens, so a second request with the same token is refused.
        // Everyone who needs a refresh at the same moment waits on one shared request.
        refreshInFlight ??= runRefresh(get, set).finally(() => {
          refreshInFlight = null;
        });
        return refreshInFlight;
      },

      lock: () => {
        set({ isLocked: true });
        useWalletStore.getState().lock();
      },

      setUnlocked: () => {
        set({ isLocked: false });
      },
    }),
    {
      name: "amma-wallet-auth",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        user: state.user,
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        isAuthenticated: state.isAuthenticated,
        signingMode: state.signingMode,
      }),
      // The lock is never saved: a cold start (including after an update) always begins locked, and the
      // wallet passphrase opens it. An older version saved this flag, so it is ignored when read back.
      merge: (persisted, current) => ({ ...current, ...(persisted as Partial<AuthState>), isLocked: true }),
    }
  )
);
