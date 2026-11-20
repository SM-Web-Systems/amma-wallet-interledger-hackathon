import net from "net";
import { appLog } from "./app-log";

/** Loopback only. Deployments set TRUST_PROXY to their reverse proxy's address. */
export const DEFAULT_TRUST_PROXY = ["127.0.0.1", "::1"];

function valid(entry: string): boolean {
  const [addr, bits, extra] = entry.split("/");
  if (extra !== undefined) return false;
  const v = net.isIP(addr);
  if (!v) return false;
  if (bits === undefined) return true;
  return /^\d+$/.test(bits) && Number(bits) <= (v === 4 ? 32 : 128);
}

/**
 * Trusted proxy list for Fastify's trustProxy, from optional TRUST_PROXY
 * (comma-separated IPs/CIDRs). Warns (counts only, never raw values) about
 * dropped entries and about an unset TRUST_PROXY in production.
 */
export function trustProxyFromEnv(
  env: Record<string, string | undefined>,
  warn: (msg: string) => void = (msg) => appLog().warn({}, msg),
): string[] {
  const entries = (env.TRUST_PROXY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = entries.filter(valid);
  const dropped = entries.length - list.length;
  if (dropped > 0) {
    warn(`[trust-proxy] ignored ${dropped} invalid TRUST_PROXY entr${dropped === 1 ? "y" : "ies"}`);
  }
  if (list.length === 0) {
    if (env.NODE_ENV === "production") {
      warn(`[trust-proxy] TRUST_PROXY is unset or has no valid entries; trusting only ${DEFAULT_TRUST_PROXY.join(", ")}. Client IPs will be the proxy's until TRUST_PROXY is set.`);
    }
    return DEFAULT_TRUST_PROXY;
  }
  return list;
}
