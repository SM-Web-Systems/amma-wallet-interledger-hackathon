// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type FakeRequest = { mode: string; method: string; url: string };
type FakeEvent = {
  request?: FakeRequest;
  waitUntil: (p: Promise<unknown>) => void;
  respondWith: (p: Promise<unknown>) => void;
};
type Listener = (event: FakeEvent) => void;

// Loads public/sw.js into a fake service-worker scope and returns its listeners.
function loadWorker(fetchImpl: (req: unknown) => Promise<unknown>) {
  const listeners: Record<string, Listener> = {};
  const store = new Map<string, unknown>();
  const cache = {
    addAll: vi.fn(async (urls: string[]) => { for (const u of urls) store.set(u, `cached:${u}`); }),
    match: vi.fn(async (u: string) => store.get(u)),
  };
  const scope = {
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    registration: {},
    location: { origin: "https://ammawallet.com" },
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ["amma-v0", ...store.keys()].filter((k) => k.startsWith("amma-"))),
    delete: vi.fn(async () => true),
  };
  const src = readFileSync(resolve(__dirname, "../../public/sw.js"), "utf8");
  new Function("self", "caches", "fetch", src)(scope, caches, fetchImpl);
  return { listeners, caches, cache };
}
async function run(listener: Listener, event: { request?: FakeRequest }) {
  let pending: Promise<unknown> | undefined;
  listener({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; }, respondWith: (p: Promise<unknown>) => { pending = p; } });
  return pending === undefined ? undefined : await pending;
}

describe("service worker", () => {
  it("has a fetch handler, so Chrome offers a full app install", () => {
    expect(loadWorker(async () => "net").listeners.fetch).toBeTypeOf("function");
  });

  it("caches only the app shell on install", async () => {
    const { listeners, cache } = loadWorker(async () => "net");
    await run(listeners.install, {});
    expect(cache.addAll).toHaveBeenCalledWith(["/"]);
  });

  it("serves page navigations from the network when online", async () => {
    const { listeners } = loadWorker(async () => "network page");
    const res = await run(listeners.fetch, { request: { mode: "navigate", method: "GET", url: "https://ammawallet.com/xrpl" } });
    expect(res).toBe("network page");
  });

  it("falls back to the cached shell for navigations when offline", async () => {
    const { listeners } = loadWorker(async () => { throw new TypeError("offline"); });
    await run(listeners.install, {});
    const res = await run(listeners.fetch, { request: { mode: "navigate", method: "GET", url: "https://ammawallet.com/xrpl" } });
    expect(res).toBe("cached:/");
  });

  it("never intercepts API or other requests (no wallet data is cached)", async () => {
    const { listeners } = loadWorker(async () => "net");
    const res = await run(listeners.fetch, { request: { mode: "cors", method: "GET", url: "https://ammawallet.com/api/v1/auth/me" } });
    expect(res).toBeUndefined();
    const post = await run(listeners.fetch, { request: { mode: "navigate", method: "POST", url: "https://ammawallet.com/" } });
    expect(post).toBeUndefined();
  });
});
