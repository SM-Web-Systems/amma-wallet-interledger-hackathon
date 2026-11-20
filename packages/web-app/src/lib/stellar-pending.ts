/** A delegated Stellar payment whose outcome is not known yet: it was submitted, but no answer said whether it applied. */
/**
 * serverHash: the hash came from the server (its fee quote or its reply), so it is the transaction the server submits.
 * Without it, the hash is the browser's own envelope: the server may have added the Amma fee and submitted a different
 * transaction, so a hash Horizon never saw proves nothing.
 */
export interface PendingStellarSend { hash: string; maxTime: number; network: "testnet" | "public"; summary: string; serverHash?: boolean }
/** "unknown": the time bound passed and only the browser's own hash is known, so whether it applied can't be told from Horizon. */
export type LookupResult = "applied" | "failed" | "waiting" | "expired" | "unknown";

/** Ledger close plus Horizon ingestion: how long after its time bound a transaction could still show up. */
export const EXPIRY_GRACE_SECONDS = 60;
const HASH = /^[0-9a-f]{64}$/;

/**
 * Looks the transaction up on Horizon (it also finds a fee-bump transaction by its inner hash).
 * "expired" only when Horizon has never seen it, its time bound has passed, and the hash is the server's: then it can no longer apply.
 * With only the browser's own hash it says "unknown" instead, never "expired".
 */
export async function lookupStellarTx(horizonUrl: string, p: { hash: string; maxTime: number; serverHash?: boolean }, now = Date.now(), f: typeof fetch = fetch): Promise<LookupResult> {
  let res: Response;
  try { res = await f(`${horizonUrl}/transactions/${encodeURIComponent(p.hash)}`); } catch { return "waiting"; }
  if (res.ok) {
    const body = await res.json().catch(() => null) as { successful?: unknown } | null;
    return body?.successful === true ? "applied" : body?.successful === false ? "failed" : "waiting";
  }
  if (res.status === 404 && p.maxTime > 0 && now / 1000 > p.maxTime + EXPIRY_GRACE_SECONDS) return p.serverHash === true ? "expired" : "unknown";
  return "waiting";
}

/** The storage key for one wallet on one network. localStorage, so every tab of this browser sees it (and gets a `storage` event). */
export const pendingSlot = (network: string, publicKey: string) => `amma.stellarPending.${network}.${publicKey}`;
const slot = pendingSlot;

/** Kept in localStorage, so a reload or another tab still blocks a second payment. Holds a hash and a summary, never XDR or secrets. */
export function savePending(publicKey: string, p: PendingStellarSend): void {
  try { localStorage.setItem(slot(p.network, publicKey), JSON.stringify(p)); } catch { /* the card on the page still blocks a new attempt */ }
}
export function loadPending(network: "testnet" | "public", publicKey: string): PendingStellarSend | null {
  try {
    const p = JSON.parse(localStorage.getItem(slot(network, publicKey)) ?? "null") as Partial<PendingStellarSend> | null;
    if (!p || typeof p.hash !== "string" || !HASH.test(p.hash) || typeof p.maxTime !== "number" || !Number.isFinite(p.maxTime) || p.network !== network) return null;
    return { hash: p.hash, maxTime: p.maxTime, network, summary: typeof p.summary === "string" ? p.summary : "", ...(p.serverHash === true ? { serverHash: true } : {}) };
  } catch { return null; }
}
export function clearPending(network: "testnet" | "public", publicKey: string): void {
  try { localStorage.removeItem(slot(network, publicKey)); } catch { /* nothing to clear */ }
}

export const stellarTxUrl = (network: "testnet" | "public", hash: string): string => `https://stellar.expert/explorer/${network}/tx/${hash}`;

/**
 * What a failed sign-and-submit call says about the envelope it carried:
 * - "unknown": it may have applied. Look the hash up; never build a new envelope first.
 * - "rejected": it did not apply and cannot apply now. The next attempt builds a new envelope.
 * - "retry": the server refused before the submit (wrong password, rate limit). Send the same envelope again.
 * `resend` is true when this envelope was already sent to the server before. Then a tx_ code is not proof:
 * a copy that already applied makes every later copy fail with tx_bad_seq, or with a check Stellar runs before the
 * sequence number (tx_too_late, tx_insufficient_fee). An op_ code comes only after the sequence check passed.
 * Same rule as submitStellarTx on the server, across requests.
 */
export type SubmitErrorClass = "unknown" | "rejected" | "retry";
/** The server stopped before anything reached the network. */
const NEVER_SENT = new Set(["account_requires_memo", "recipient_check_failed"]);
export function classifySubmitError(err: unknown, resend: boolean): SubmitErrorClass {
  // No answer at all, or a 2xx body that was not JSON.
  if (err instanceof TypeError || err instanceof SyntaxError) return "unknown";
  const e = (err ?? {}) as { code?: unknown; status?: unknown; unreadable?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  if (code === "timeout") return "unknown";
  if (code.startsWith("op_") || NEVER_SENT.has(code)) return "rejected";
  if (code.startsWith("tx_")) return resend ? "unknown" : "rejected";
  // Our own 500 (for example auditLog failing after the submit), a proxy 502/504/524, or an HTML page.
  if (e.unreadable === true || (typeof e.status === "number" && e.status >= 500)) return "unknown";
  return "retry";
}
