// Seen on a real phone, 2026-11-13: after the app had been closed for a while, reopening it sent two
// refresh requests at once. The server rotates refresh tokens, so the second one got a 401 and the app
// signed the person out. All callers must share one refresh.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(async () => {}), getItemAsync: vi.fn(async () => null), deleteItemAsync: vi.fn(async () => {}),
}));
vi.mock("../wallet", () => ({
  useWalletStore: { getState: () => new Proxy({}, { get: () => vi.fn(async () => {}) }) },
}));

// A server that rotates refresh tokens: each one works once.
const server = { valid: "r1", next: 2, requests: 0, onRequest: null as null | (() => void) };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
  if (!String(url).endsWith("/api/v1/auth/refresh")) return json(404, { error: "not found" });
  server.requests += 1;
  server.onRequest?.();
  await new Promise((r) => setTimeout(r, 10));
  const sent = JSON.parse(String(init?.body)).refreshToken;
  if (sent !== server.valid) return json(401, { error: "Invalid refresh token" });
  const n = server.next++;
  server.valid = `r${n}`;
  return json(200, { accessToken: `a${n}`, refreshToken: `r${n}` });
}) as typeof fetch;

import { useAuthStore } from "../auth";

beforeEach(() => {
  server.valid = "r1";
  server.next = 2;
  server.requests = 0;
  server.onRequest = null;
  useAuthStore.setState({ isAuthenticated: true, accessToken: "a1", refreshToken: "r1", user: { id: 1 } as never });
});

describe("refreshSession", () => {
  it("shares one request between callers that ask at the same time, and keeps the person signed in", async () => {
    const results = await Promise.all([
      useAuthStore.getState().refreshSession(),
      useAuthStore.getState().refreshSession(),
      useAuthStore.getState().refreshSession(),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(server.requests).toBe(1);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, accessToken: "a2", refreshToken: "r2" });
  });

  it("makes a new request for a later, separate refresh", async () => {
    expect(await useAuthStore.getState().refreshSession()).toBe(true);
    expect(await useAuthStore.getState().refreshSession()).toBe(true);
    expect(server.requests).toBe(2);
    expect(useAuthStore.getState().refreshToken).toBe("r3");
  });

  it("does not sign out when the server refuses a token that another refresh has already replaced", async () => {
    // The stored token changes while this request is in flight, as if another refresh finished first.
    server.onRequest = () => useAuthStore.setState({ accessToken: "a9", refreshToken: "r9" });
    server.valid = "something else"; // this request is refused with 401
    expect(await useAuthStore.getState().refreshSession()).toBe(true);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, accessToken: "a9", refreshToken: "r9" });
  });

  it("signs out when the refresh token really is no longer valid", async () => {
    server.valid = "something else";
    expect(await useAuthStore.getState().refreshSession()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, accessToken: null, refreshToken: null, user: null });
  });

  it("does nothing without a refresh token", async () => {
    useAuthStore.setState({ refreshToken: null });
    expect(await useAuthStore.getState().refreshSession()).toBe(false);
    expect(server.requests).toBe(0);
  });
});
