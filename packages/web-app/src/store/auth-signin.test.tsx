import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

const m = vi.hoisted(() => ({ ensure: vi.fn(), list: vi.fn(), register: vi.fn(), login: vi.fn(), mode: vi.fn() }));
vi.mock("../lib/custody-onboard", () => ({ ensureCustodyWallets: m.ensure, CUSTODY_CHANGED: "amma:custody:changed" }));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return {
    ...real,
    setTokens: vi.fn(),
    authApi: { ...real.authApi, register: m.register, login: m.login },
    userWalletApi: { ...real.userWalletApi, list: m.list },
    signingApi: { ...real.signingApi, getMode: m.mode },
  };
});

import { useAuthStore } from "./auth";
import { useWalletStore } from "./wallet";

const AMMA = { id: 5, name: "Amma Stellar", publicKey: "GAMMASTELLAR", network: "testnet", isActive: true, hasServerKey: false, createdAt: "2026-11-16T00:00:00Z" };
const user = { id: 9, email: "new@example.invalid", firstName: null, lastName: null, avatar: null, preferredLanguage: "en", preferredNetwork: "testnet" };

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  localStorage.clear();
  Object.values(m).forEach((f) => f.mockReset());
  useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false, serverWallets: [], signingMode: "self" });
  useWalletStore.setState({ accounts: [], activeAccountId: null } as never);
  m.mode.mockResolvedValue("delegated");
  m.register.mockResolvedValue({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", user });
  m.login.mockResolvedValue({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", user });
  // The server lists the Amma Stellar wallet only after setup ran; setup must run before the user counts as signed in.
  let created = false;
  m.ensure.mockImplementation(async () => { expect(useAuthStore.getState().isAuthenticated).toBe(false); created = true; });
  m.list.mockImplementation(async () => (created ? [AMMA] : []));
});

describe.each(["register", "login"] as const)("%s", (action) => {
  const run = () => action === "register"
    ? useAuthStore.getState().register("new@example.invalid", "Synthetic-Passw0rd", undefined, undefined, "synthetic-captcha")
    : useAuthStore.getState().login("new@example.invalid", "Synthetic-Passw0rd", "synthetic-captcha");

  it("waits for Amma wallet setup before marking the user signed in", async () => {
    await run();
    expect(m.ensure).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it("counts the Amma Stellar wallet as the active wallet", async () => {
    await run();
    const wallets = useWalletStore.getState();
    expect(wallets.accounts.map((a) => a.publicKey)).toEqual(["GAMMASTELLAR"]);
    expect(wallets.activeAccountId).toBe(wallets.accounts[0].id);
  });

  it("still signs in when Amma wallet setup is off", async () => {
    m.ensure.mockResolvedValue(undefined); // off, self-custody or timed out: nothing created
    await run();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useWalletStore.getState().accounts).toEqual([]);
  });
});

it("uses the server signing mode after register", async () => {
  await useAuthStore.getState().register("new@example.invalid", "Synthetic-Passw0rd", undefined, undefined, "synthetic-captcha");
  expect(useAuthStore.getState().signingMode).toBe("delegated");
});
