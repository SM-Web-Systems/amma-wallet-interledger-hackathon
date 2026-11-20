import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { trustProxyFromEnv, DEFAULT_TRUST_PROXY } from "./trust-proxy";

describe("trustProxyFromEnv", () => {
  it("defaults to loopback only", () => {
    expect(trustProxyFromEnv({})).toEqual(["127.0.0.1", "::1"]);
    expect(DEFAULT_TRUST_PROXY).toEqual(["127.0.0.1", "::1"]);
  });
  it("env overrides the default", () => {
    expect(trustProxyFromEnv({ TRUST_PROXY: "10.1.2.3, 172.22.0.0/16" })).toEqual(["10.1.2.3", "172.22.0.0/16"]);
  });
  it("drops invalid entries and warns with a count only", () => {
    const warn = vi.fn();
    expect(trustProxyFromEnv({ TRUST_PROXY: " ,nonsense,10.0.0.0/99,1.2.3.4,," }, warn)).toEqual(["1.2.3.4"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("2 invalid");
    expect(warn.mock.calls[0][0]).not.toContain("nonsense");
  });
  it("warns in production when unset, not otherwise", () => {
    const warn = vi.fn();
    trustProxyFromEnv({ NODE_ENV: "production" }, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const quiet = vi.fn();
    trustProxyFromEnv({ NODE_ENV: "development" }, quiet);
    trustProxyFromEnv({ NODE_ENV: "production", TRUST_PROXY: "172.22.0.5" }, quiet);
    expect(quiet).not.toHaveBeenCalled();
  });
});

describe("request.ip with trustProxy", () => {
  const ipFor = async (remoteAddress: string, xff: string, env: Record<string, string> = {}) => {
    const app = Fastify({ trustProxy: trustProxyFromEnv(env, () => {}) });
    app.get("/ip", async (r) => ({ ip: r.ip }));
    const res = await app.inject({ method: "GET", url: "/ip", remoteAddress, headers: { "x-forwarded-for": xff } });
    await app.close();
    return res.json().ip;
  };
  it("takes the rightmost untrusted XFF entry from a trusted proxy", async () => {
    expect(await ipFor("172.22.0.5", "6.6.6.6, 203.0.113.9", { TRUST_PROXY: "172.22.0.5" })).toBe("203.0.113.9");
    expect(await ipFor("127.0.0.1", "6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
  });
  it("ignores XFF from an untrusted peer", async () => {
    expect(await ipFor("198.51.100.1", "6.6.6.6, 203.0.113.9")).toBe("198.51.100.1");
  });
  it("does not trust a private peer under the narrowed default", async () => {
    expect(await ipFor("172.22.0.1", "6.6.6.6, 172.22.0.1")).toBe("172.22.0.1");
  });
  it("trusts an IPv4-mapped loopback socket", async () => {
    expect(await ipFor("::ffff:127.0.0.1", "6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
  });
  it("returns an IPv6 client entry", async () => {
    expect(await ipFor("127.0.0.1", "2001:db8::1")).toBe("2001:db8::1");
  });
});
