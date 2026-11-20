// Sign-in and registration must carry the Turnstile token, or the API answers
// 400 "Human verification required" (seen on a real phone, 2026-11-12).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(async () => {}), getItemAsync: vi.fn(async () => null), deleteItemAsync: vi.fn(async () => {}),
}));
// Any wallet-store action the auth store calls after signing in is a no-op here.
vi.mock("../wallet", () => ({
  useWalletStore: { getState: () => new Proxy({}, { get: () => vi.fn(async () => {}) }) },
}));

const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
  return new Response(JSON.stringify({ user: { id: 1 }, accessToken: "a", refreshToken: "r" }), {
    status: 200, headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

import { useAuthStore } from "../auth";

beforeEach(() => { calls.length = 0; });

describe("auth requests carry the human-verification token", () => {
  it("login sends turnstileToken", async () => {
    await useAuthStore.getState().login("a@example.com", "pw", undefined, "tok-1");
    const login = calls.find((c) => c.url.endsWith("/api/v1/auth/login"))!;
    expect(login.body).toMatchObject({ email: "a@example.com", password: "pw", turnstileToken: "tok-1" });
  });

  it("the 2FA step sends the code (the API skips the captcha there)", async () => {
    await useAuthStore.getState().login("a@example.com", "pw", "123456");
    const login = calls.find((c) => c.url.endsWith("/api/v1/auth/login"))!;
    expect(login.body).toMatchObject({ twoFaToken: "123456" });
    expect(login.body).not.toHaveProperty("turnstileToken");
  });

  it("register sends turnstileToken", async () => {
    await useAuthStore.getState().register({ email: "b@example.com", password: "pw" }, "tok-2");
    const reg = calls.find((c) => c.url.endsWith("/api/v1/auth/register"))!;
    expect(reg.body).toMatchObject({ email: "b@example.com", password: "pw", turnstileToken: "tok-2" });
  });
});
