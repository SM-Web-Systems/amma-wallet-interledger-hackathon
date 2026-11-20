import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
vi.mock("../db", () => ({ db: {}, schema: {} }));
vi.mock("../config", () => ({ config: { API_KEYS: [] } }));

import { rateLimitKey, createCachedResolver } from "./rate-limit-key";

const req = (headers: Record<string, any> = {}, ip = "1.2.3.4") => ({ headers, ip }) as any;
const none = vi.fn(async () => undefined);

describe("rateLimitKey", () => {
  it("uses the ip when there is no header", async () => {
    expect(await rateLimitKey(req(), none)).toBe("ip:1.2.3.4");
  });

  it("maps different invalid keys from one IP to the same bucket", async () => {
    const a = await rateLimitKey(req({ "x-api-key": "random-aaa" }), none);
    const b = await rateLimitKey(req({ "x-api-key": "random-bbb" }), none);
    expect(a).toBe("ip:1.2.3.4");
    expect(b).toBe(a);
    expect(a).toBe(await rateLimitKey(req(), none));
  });

  it("uses the tenant key id for a valid db key", async () => {
    const resolve = vi.fn(async () => ({
      source: "db" as const, tenantId: 7, keyId: 42, scopes: [], rateLimitPerMinute: 60,
    }));
    const k = await rateLimitKey(req({ "x-api-key": "secret-raw-key" }), resolve);
    expect(k).toBe("tenant-key:db:42");
    expect(k).not.toContain("secret-raw-key");
    expect(resolve).toHaveBeenCalledWith("secret-raw-key");
  });

  it("buckets a valid env key without exposing it", async () => {
    const resolve = vi.fn(async () => ({
      source: "env" as const, tenantId: null, keyId: null, scopes: [], rateLimitPerMinute: 60,
    }));
    const k = await rateLimitKey(req({ "x-api-key": "secret-env-key" }), resolve);
    expect(k).toMatch(/^tenant-key:env:[0-9a-f]{16}$/);
    expect(k).not.toContain("secret-env-key");
  });

  it("falls back to the ip when resolve throws, without leaking the key", async () => {
    const resolve = vi.fn(async () => { throw new Error("db down secret-raw-key"); });
    const k = await rateLimitKey(req({ "x-api-key": "secret-raw-key" }), resolve);
    expect(k).toBe("ip:1.2.3.4");
  });

  it("ignores non-string/array header values", async () => {
    expect(await rateLimitKey(req({ "x-api-key": ["a", "b"] }), none)).toBe("ip:1.2.3.4");
  });
});

describe("rateLimitKey IPv6 buckets", () => {
  const k = (ip: string) => rateLimitKey(req({}, ip), none);
  it("keys IPv6 on the /64", async () => {
    expect(await k("2001:db8:1:2:aaaa::1")).toBe("ip6:2001:db8:1:2::/64");
    expect(await k("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("ip6:2001:db8:1:2::/64");
    expect(await k("2001:db8:1:3::1")).not.toBe(await k("2001:db8:1:2::1"));
    expect(await k("2001:db8::1")).toBe("ip6:2001:db8:0:0::/64");
  });
  it("keeps ip:<v4> for IPv4 and IPv4-mapped", async () => {
    expect(await k("203.0.113.9")).toBe("ip:203.0.113.9");
    expect(await k("::ffff:203.0.113.9")).toBe("ip:203.0.113.9");
    expect(await k("::ffff:cb00:7109")).toBe("ip:203.0.113.9");
  });
});

describe("createCachedResolver", () => {
  const ctx = { source: "db" as const, tenantId: 1, keyId: 1, scopes: [], rateLimitPerMinute: 60 };
  it("serves the second call within the TTL from cache", async () => {
    const r = vi.fn(async () => ctx);
    const c = createCachedResolver(r, { now: () => 0 });
    await c("k"); await c("k");
    expect(r).toHaveBeenCalledTimes(1);
  });
  it("caches negative results", async () => {
    const r = vi.fn(async () => undefined);
    const c = createCachedResolver(r, { now: () => 0 });
    expect(await c("bad")).toBeUndefined(); await c("bad");
    expect(r).toHaveBeenCalledTimes(1);
  });
  it("expires after the TTL", async () => {
    let t = 0;
    const r = vi.fn(async () => ctx);
    const c = createCachedResolver(r, { ttlMs: 60_000, now: () => t });
    await c("k"); t = 59_999; await c("k"); expect(r).toHaveBeenCalledTimes(1);
    t = 60_000; await c("k"); expect(r).toHaveBeenCalledTimes(2);
  });
  it("respects the size bound by evicting the oldest", async () => {
    const r = vi.fn(async () => undefined);
    const c = createCachedResolver(r, { max: 2, now: () => 0 });
    await c("a"); await c("b"); await c("c");
    expect(r).toHaveBeenCalledTimes(3);
    await c("c"); await c("b"); expect(r).toHaveBeenCalledTimes(3);
    await c("a"); expect(r).toHaveBeenCalledTimes(4);
  });
  it("does not cache errors", async () => {
    const r = vi.fn(async () => { throw new Error("x"); });
    const c = createCachedResolver(r);
    await expect(c("k")).rejects.toThrow(); await expect(c("k")).rejects.toThrow();
    expect(r).toHaveBeenCalledTimes(2);
  });
});

describe("rate limiter integration", () => {
  it("rotating random X-API-Key values does not escape the limit", async () => {
    const app = Fastify();
    await app.register(fastifyRateLimit, {
      max: 2,
      timeWindow: "1 minute",
      keyGenerator: (r) => rateLimitKey(r, async () => undefined),
    });
    app.get("/x", async () => ({ ok: true }));
    const codes: number[] = [];
    for (const k of ["rand-1", "rand-2", "rand-3"]) {
      const res = await app.inject({ method: "GET", url: "/x", headers: { "x-api-key": k }, remoteAddress: "9.9.9.9" });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    await app.close();
  });
});
