import { StellarRecipientCheckFailed, StellarSubmitUncertain, stellarResultCodes } from "./stellar-submit-errors";

/** The part of the stellar-sdk Horizon server this needs (so tests can pass a fake). */
export interface HorizonSubmitter {
  submitTransaction(tx: any, opts?: { skipMemoRequiredCheck?: boolean }): Promise<any>;
  checkMemoRequired?(tx: any): Promise<void>;
  transactions?(): { transaction(hash: string): { call(): Promise<any> } };
}

export interface SubmitOptions {
  /** Per attempt. The SDK's own limit is 60s; the wallet SDK this replaces retried a 504 forever. */
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  /** Bound on the recipient memo check and on each ledger lookup. */
  memoTimeoutMs?: number;
  lookupTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rejects with `onTimeout()` if `work` has not settled in `ms`. */
export async function bounded<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const is404 = (e: any) => e?.response?.status === 404 || e?.name === "NotFoundError";

/** What the ledger says about a transaction: its record, "absent" (Horizon answered 404) or "unknown" (could not tell). */
async function onLedger(horizon: HorizonSubmitter, tx: any, ms: number): Promise<{ record: any } | "absent" | "unknown"> {
  if (!horizon.transactions || typeof tx?.hash !== "function") return "unknown";
  try {
    const hash = tx.hash().toString("hex");
    const record = await bounded(horizon.transactions().transaction(hash).call(), ms, () => new StellarSubmitUncertain());
    return { record };
  } catch (e) {
    return is404(e) ? "absent" : "unknown";
  }
}

/** Horizon's own shape for a transaction that is on the ledger but failed, so callers map it like any rejection. */
const failedOnLedger = () =>
  Object.assign(new Error("Transaction failed on the ledger"), { response: { status: 400, data: { extras: { result_codes: { transaction: "tx_failed" } } } } });

/**
 * Submits a signed transaction straight to Horizon with a bounded time and a bounded number of tries.
 * Re-sending the same signed envelope is safe: it has one hash, so it can only apply once.
 *
 * - A Horizon answer with result codes on the first try means the transaction was NOT applied: the original error is thrown.
 * - Any other 4xx (malformed request) also means not applied: the original error is thrown.
 * - No answer, a timeout, 408/429 or a 5xx leaves the outcome unknown. Once any attempt was unknown, nothing is
 *   reported as rejected (a retry can say tx_too_late or tx_bad_seq precisely because the first send applied) until the
 *   transaction hash has been looked up: applied -> success, applied but failed -> rejection, not found -> StellarSubmitUncertain.
 * Only the submit call is covered, so an error from anywhere else in a route is never reported as "unconfirmed".
 */
export async function submitStellarTx(horizon: HorizonSubmitter, tx: any, o: SubmitOptions = {}): Promise<any> {
  const { timeoutMs = 25_000, attempts = 2, retryDelayMs = 1_000, memoTimeoutMs = 10_000, lookupTimeoutMs = 10_000 } = o;
  // SEP-29 check happens before anything is sent. It fails closed: a recipient we could not check is not paid.
  if (horizon.checkMemoRequired) {
    try {
      await bounded(horizon.checkMemoRequired(tx), memoTimeoutMs, () => new StellarRecipientCheckFailed());
    } catch (e) {
      if ((e as any)?.name === "AccountRequiresMemoError") throw e;
      throw new StellarRecipientCheckFailed();
    }
  }
  let unknownSeen = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await bounded(horizon.submitTransaction(tx, { skipMemoRequiredCheck: true }), timeoutMs, () => new StellarSubmitUncertain());
    } catch (e: any) {
      const status = e?.response?.status;
      const answered = typeof status === "number";
      const rejection = stellarResultCodes(e) !== null || (answered && status >= 400 && status < 500 && status !== 408 && status !== 429);
      if (rejection) {
        if (!unknownSeen) throw e;
        return settleByLedger(horizon, tx, lookupTimeoutMs, e);
      }
      unknownSeen = true;
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  return settleByLedger(horizon, tx, lookupTimeoutMs, null);
}

async function settleByLedger(horizon: HorizonSubmitter, tx: any, ms: number, rejection: unknown): Promise<any> {
  const found = await onLedger(horizon, tx, ms);
  if (typeof found === "object") {
    if (found.record?.successful === false) throw failedOnLedger();
    return found.record;
  }
  // Not found, or could not tell: the first send may still land, so this is never "rejected".
  void rejection;
  throw new StellarSubmitUncertain();
}
