import { getNetworkConfig } from "./constants";

export type StellarNetwork = "testnet" | "public";

export type OpDetail = {
  id: string;
  type: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  destination: string;
  source: string;
  sourceAmount?: string;
  sourceAssetCode?: string;
  /** The payment of the platform fee that Amma adds next to the user's payment. */
  platformFee: boolean;
};

export type TxDetails = {
  hash: string;
  ledger: number | null;
  createdAt: string;
  successful: boolean;
  feeXlm: string;
  feeBump: { outerHash: string; innerHash: string; feeAccount: string } | null;
  memo: { type: string; value: string };
  operations: OpDetail[];
  explorerUrl: string;
};

type H = Record<string, unknown>;
const HASH_RE = /^[0-9a-f]{64}$/i;
const OP_ID_TYPES = new Set(["payment", "create_account", "path_payment_strict_send", "path_payment_strict_receive"]);

export const explorerTxUrl = (network: StellarNetwork, hash: string) =>
  `https://stellar.expert/explorer/${network === "testnet" ? "testnet" : "public"}/tx/${hash}`;

export const historyDetailPath = (hash: string) => `/history?tx=${hash}`;

/** The hash from a Horizon submit result, or from the server's `{ success, result }` wrapper. */
export function extractTxHash(r: unknown): string | null {
  const o = r as { hash?: unknown; id?: unknown; result?: unknown } | null;
  if (!o || typeof o !== "object") return null;
  for (const c of [o.hash, o.id]) if (typeof c === "string" && HASH_RE.test(c)) return c;
  return o.result && o.result !== r ? extractTxHash(o.result) : null;
}

export const hasOperationId = (op: Pick<OpDetail, "id" | "type">) => !!op.id && OP_ID_TYPES.has(op.type);

const stroopsToXlm = (s: unknown) => (Number(s ?? 0) / 1e7).toFixed(7);

function memoOf(tx: H): { type: string; value: string } {
  const type = String(tx.memo_type ?? "none");
  if (type === "none" || tx.memo == null) return { type, value: "" };
  if (type === "hash" || type === "return") {
    // Horizon sends hash memos as base64; show the 64-character hex a payment request uses.
    try {
      const bin = atob(String(tx.memo));
      return { type, value: Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("") };
    } catch {
      return { type, value: String(tx.memo) };
    }
  }
  return { type, value: String(tx.memo) };
}

const asset = (type: unknown, code: unknown, issuer: unknown) =>
  type === "native" || !code ? { code: "XLM", issuer: null } : { code: String(code), issuer: issuer ? String(issuer) : null };

function opOf(op: H): OpDetail {
  const a = asset(op.asset_type, op.asset_code, op.asset_issuer);
  const base = { platformFee: false, id: String(op.id ?? ""), type: String(op.type ?? "unknown"), source: String(op.source_account ?? op.from ?? op.funder ?? "") };
  if (op.type === "create_account") {
    return { ...base, amount: String(op.starting_balance ?? ""), assetCode: "XLM", assetIssuer: null, destination: String(op.account ?? ""), source: String(op.funder ?? base.source) };
  }
  const out: OpDetail = { ...base, amount: String(op.amount ?? ""), assetCode: a.code, assetIssuer: a.issuer, destination: String(op.to ?? "") };
  if (op.source_amount != null) {
    out.sourceAmount = String(op.source_amount);
    out.sourceAssetCode = asset(op.source_asset_type, op.source_asset_code, op.source_asset_issuer).code;
  }
  return out;
}

/** Flags the payment to the platform wallet (only when it is not the sole operation) and puts it after the user's operations. */
function orderOps(ops: OpDetail[], platformWallet: string): OpDetail[] {
  const flagged = ops.map((o) => ({ ...o, platformFee: !!platformWallet && o.type === "payment" && o.destination === platformWallet }));
  if (flagged.every((o) => o.platformFee)) return ops;
  return [...flagged.filter((o) => !o.platformFee), ...flagged.filter((o) => o.platformFee)];
}

export function mapHorizonTx(tx: H, ops: H[], network: StellarNetwork, platformWallet: string = import.meta.env.VITE_PLATFORM_WALLET || ""): TxDetails {
  const hash = String(tx.hash ?? tx.id ?? "");
  const inner = tx.inner_transaction as H | undefined;
  return {
    hash,
    ledger: typeof tx.ledger === "number" ? tx.ledger : tx.ledger != null ? Number(tx.ledger) : null,
    createdAt: String(tx.created_at ?? ""),
    successful: tx.successful !== false,
    feeXlm: stroopsToXlm(tx.fee_charged),
    feeBump: tx.fee_bump_transaction && inner
      ? { outerHash: String((tx.fee_bump_transaction as H).hash ?? hash), innerHash: String(inner.hash), feeAccount: String(tx.fee_account ?? "") }
      : null,
    memo: memoOf(tx),
    operations: orderOps(ops.map(opOf), platformWallet),
    explorerUrl: explorerTxUrl(network, hash),
  };
}

class TransientHorizonError extends Error {}
const transient = (status: number) => status === 429 || status >= 500;

/** Transaction plus operations from the Horizon of the given network. null = not ingested yet (404). */
export async function fetchTxDetails(network: StellarNetwork, hash: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<TxDetails | null> {
  const base = `${getNetworkConfig(network).horizonUrl}/transactions/${hash}`;
  const txRes = await fetchImpl(base, { signal });
  if (txRes.status === 404) return null;
  if (!txRes.ok) throw transient(txRes.status) ? new TransientHorizonError(`Horizon error: ${txRes.status}`) : new Error(`Horizon error: ${txRes.status}`);
  const opsRes = await fetchImpl(`${base}/operations?limit=200`, { signal });
  if (!opsRes.ok) throw transient(opsRes.status) ? new TransientHorizonError(`Horizon error: ${opsRes.status}`) : new Error(`Horizon error: ${opsRes.status}`);
  const ops = await opsRes.json();
  return mapHorizonTx(await txRes.json(), ops?._embedded?.records ?? [], network);
}

/** Bounded retry: not ingested yet (404), 429, 5xx and network errors are tried again; other errors are thrown. */
export async function fetchTxDetailsWithRetry(
  network: StellarNetwork,
  hash: string,
  o: { fetchImpl?: typeof fetch; attempts?: number; delayMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TxDetails | null> {
  const { attempts = 6, delayMs = 2000, signal, fetchImpl } = o;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) return null;
    try {
      const d = await fetchTxDetails(network, hash, fetchImpl, signal);
      if (d) return d;
    } catch (e) {
      if (signal?.aborted) return null;
      // A failed fetch() is a TypeError; anything that is not transient (4xx, bad JSON) is a real error.
      if (!(e instanceof TransientHorizonError || e instanceof TypeError)) throw e;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return null;
}
