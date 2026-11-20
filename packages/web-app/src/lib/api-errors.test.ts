import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "./api";

describe("request() errors", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("keeps the status, the top-level code, and whether the body could be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "busy", code: "tx_bad_seq" }), { status: 409 })));
    await expect(request("/api/v1/transactions/sign-and-submit", { method: "POST" })).rejects.toMatchObject({ message: "busy", code: "tx_bad_seq", status: 409, unreadable: false });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    await expect(request("/api/v1/transactions/sign-and-submit", { method: "POST" })).rejects.toMatchObject({ message: "API error 502", status: 502, unreadable: true });
  });
  it('keeps the time a locked sign-in opens again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Too many wrong passwords.', retryAt: '2026-11-17T10:30:00.000Z' }), { status: 423 })));
    await expect(request('/api/v1/auth/login', { method: 'POST', auth: false })).rejects.toMatchObject({ status: 423, retryAt: '2026-11-17T10:30:00.000Z' });
  });
});
