import net from "net";
import type { FastifyRequest } from "fastify";
import {
  hashApiKey,
  resolveTenantApiKey,
  type TenantApiKeyContext,
} from "../middleware/tenant-api-key";

type Resolver = (rawKey: string) => Promise<TenantApiKeyContext | undefined>;

/**
 * Bounded TTL cache around a key resolver. Entries (including negative
 * results) are keyed by SHA-256 of the raw key; the raw key is never stored.
 * Errors are not cached.
 */
export function createCachedResolver(
  resolve: Resolver,
  opts: { max?: number; ttlMs?: number; now?: () => number } = {},
): Resolver {
  const { max = 1000, ttlMs = 60_000, now = Date.now } = opts;
  const cache = new Map<string, { value: TenantApiKeyContext | undefined; expires: number }>();
  return async (rawKey) => {
    const k = hashApiKey(rawKey);
    const hit = cache.get(k);
    if (hit && hit.expires > now()) return hit.value;
    if (hit) cache.delete(k);
    const value = await resolve(rawKey);
    while (cache.size >= max) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(k, { value, expires: now() + ttlMs });
    return value;
  };
}

const cachedResolveTenantApiKey = createCachedResolver(resolveTenantApiKey);

/** Expand an IPv6 address into 8 numeric hextets, or null if unparseable. */
function hextets(input: string): number[] | null {
  let addr = input.split("%")[0];
  const v4tail = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const o = v4tail[2].split(".").map(Number);
    addr = v4tail[1] + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail, extra] = addr.split("::");
  if (extra !== undefined) return null;
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const all = [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/** IPv4 and IPv4-mapped keep `ip:<v4>`; other IPv6 share one bucket per /64. */
function ipBucket(ip: string): string {
  if (net.isIPv6(ip.split("%")[0])) {
    const h = hextets(ip);
    if (h) {
      if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) {
        return `ip:${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
      }
      return `ip6:${h.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
    }
  }
  return `ip:${ip}`;
}

/**
 * Rate-limit bucket key. Only an API key that actually resolves (DB or env)
 * gets its own bucket; any other X-API-Key value falls back to the client IP,
 * so rotating random header values cannot mint fresh buckets. The raw key is
 * never part of the returned string.
 */
export async function rateLimitKey(
  request: Pick<FastifyRequest, "headers" | "ip">,
  resolve: Resolver = cachedResolveTenantApiKey,
): Promise<string> {
  const raw = request.headers["x-api-key"];
  if (typeof raw === "string" && raw) {
    try {
      const ctx = await resolve(raw);
      if (ctx) {
        return ctx.keyId != null
          ? `tenant-key:${ctx.source}:${ctx.keyId}`
          : `tenant-key:env:${hashApiKey(raw).slice(0, 16)}`;
      }
    } catch {
      // fall through to IP
    }
  }
  return ipBucket(request.ip);
}
