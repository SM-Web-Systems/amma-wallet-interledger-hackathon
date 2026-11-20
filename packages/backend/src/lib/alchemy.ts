import { custodyNetworks } from "./custody-networks";

/**
 * Alchemy JSON-RPC for the Ethereum server-data features. The RPC URL carries the API key, so it is never logged,
 * never put in an error and never returned: every failure surfaces as an AlchemyError with a short code only.
 */
type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface EthDataFlags { serverData: boolean; sendSimulate: boolean; alerts: boolean }
/** Only the exact value "on" switches a feature on. */
export const ethDataFlagsFromEnv = (env: Env = process.env): EthDataFlags => ({
  serverData: env.ETH_SERVER_DATA === "on", sendSimulate: env.ETH_SEND_SIMULATE === "on", alerts: env.ETH_ALERTS === "on",
});

export class AlchemyError extends Error {
  constructor(public code: string) { super(code); this.name = "AlchemyError"; }
}

/** The server's RPC for the custody network: CUSTODY_ETH_RPC_URL on mainnet, the Sepolia custody/welcome URL otherwise. Null when not configured. */
export function alchemyUrlFromEnv(env: Env = process.env): string | null {
  const url = custodyNetworks(env).mainnet ? env.CUSTODY_ETH_RPC_URL : env.CUSTODY_SEPOLIA_RPC_URL || env.WELCOME_SEPOLIA_RPC_URL;
  return url && /^https:\/\//.test(url) ? url : null;
}

export async function alchemyCall<T>(url: string, method: string, params: unknown[], fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
    if (!res.ok) throw new AlchemyError(`http_${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code?: number } };
    if (body?.error) throw new AlchemyError(`rpc_${typeof body.error.code === "number" ? body.error.code : "error"}`);
    if (!body || !("result" in body)) throw new AlchemyError("bad_response");
    return body.result as T;
  } catch (e) {
    if (e instanceof AlchemyError) throw e;
    // Network errors from fetch can quote the URL: keep only a fixed code.
    throw new AlchemyError(ctl.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

export const hexToBigInt = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new AlchemyError("bad_response");
  return v === "0x" ? 0n : BigInt(v);
};

export const toHex = (n: bigint): string => "0x" + n.toString(16);

/**
 * An exact decimal string for an Alchemy amount. Alchemy sends `value` as a JSON NUMBER (a float), so the exact amount comes from the hex
 * `rawContract.value` (webhooks: `rawValue`) and the hex or numeric decimals. Falls back to the number only when the raw parts are missing or bad.
 */
export function exactAmount(raw: { value?: unknown; rawValue?: unknown; decimal?: unknown; decimals?: unknown } | null | undefined, fallback: unknown): string | null {
  const hex = raw?.value ?? raw?.rawValue;
  const d = raw?.decimal ?? raw?.decimals;
  const decimals = typeof d === "number" ? d : typeof d === "string" && /^0x[0-9a-fA-F]{1,2}$/.test(d) ? Number(d) : typeof d === "string" && /^[0-9]{1,2}$/.test(d) ? Number(d) : NaN;
  if (typeof hex === "string" && /^0x[0-9a-fA-F]+$/.test(hex) && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
    const digits = BigInt(hex).toString().padStart(decimals + 1, "0");
    const whole = digits.slice(0, digits.length - decimals), frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  }
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback.toLocaleString("en-US", { maximumFractionDigits: 18, useGrouping: false }) : null;
}

/** Alchemy lists every native-ETH transfer a second time as a pseudo token log from this system address (asset null). It is not a token. */
export const NATIVE_ETH_LOG_ADDRESS = "0xfffffffffffffffffffffffffffffffffffffffe";
