// Found on a real phone, 2026-11-13: after an in-place update the app opened straight onto the Dashboard
// without asking for the passphrase. The lock flag was saved to storage, so an app that was last left
// unlocked came back unlocked. A cold start must always begin locked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => stored.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => void stored.set(k, v)),
    removeItem: vi.fn(async (k: string) => void stored.delete(k)),
  },
}));
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(async () => {}), getItemAsync: vi.fn(async () => null), deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock("../wallet", () => ({
  useWalletStore: { getState: () => new Proxy({}, { get: () => vi.fn(async () => {}) }) },
}));

import { useAuthStore } from "../auth";

const KEY = "amma-wallet-auth";

beforeEach(() => stored.clear());

describe("app lock on a cold start", () => {
  it("never saves the lock flag", async () => {
    useAuthStore.setState({ isAuthenticated: true, isLocked: false, accessToken: "a", refreshToken: "r" });
    const saved = JSON.parse(stored.get(KEY) ?? "{}");
    expect(saved.state).toBeDefined();
    expect(saved.state).not.toHaveProperty("isLocked");
    // the session itself is still saved, so the person is not signed out
    expect(saved.state).toMatchObject({ isAuthenticated: true, accessToken: "a", refreshToken: "r" });
  });

  it("starts locked even if an older version saved the app as unlocked", async () => {
    stored.set(KEY, JSON.stringify({ state: { isAuthenticated: true, isLocked: false, accessToken: "a", refreshToken: "r", user: { id: 1 } }, version: 0 }));
    useAuthStore.setState({ isLocked: false });
    await useAuthStore.persist.rehydrate();
    expect(useAuthStore.getState().isLocked).toBe(true);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
