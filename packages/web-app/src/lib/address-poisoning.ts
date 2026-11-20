/**
 * Address poisoning: right after a real transfer, a scam bot sends a tiny payment from an address whose first and last
 * characters match a real counterparty (or your own address). History shows addresses shortened, so the fake looks the
 * same, and a later copy from History pays the scammer. Seen on mainnet on 2026-11-17 (0.0001 XLM, 10 s after each
 * activation). This marks such incoming dust so History can hide it and warn.
 */
export const DUST_MAX_XLM = 0.01;
const EDGE = 4;

/** Different addresses with the same first and last 4 characters. */
export const looksAlike = (a: string, b: string): boolean =>
  !!a && !!b && a !== b && a.length === b.length && a.slice(0, EDGE) === b.slice(0, EDGE) && a.slice(-EDGE) === b.slice(-EDGE);

type Op = Record<string, any>;
const fromOf = (op: Op): string => op.from || op.funder || op.source_account || op.sourceAccount || "";
const toOf = (op: Op): string => op.to || op.account || "";
const amountOf = (op: Op): number => parseFloat(op.amount ?? op.starting_balance ?? op.startingBalance ?? "0") || 0;
const isNative = (op: Op): boolean => op.type === "create_account" || op.asset_type === "native" || op.assetType === "native";
export const keyOf = (op: Op, index: number): string => String(op.id ?? op.transaction_hash ?? op.transactionHash ?? index);

/**
 * Keys (see keyOf) of incoming native payments of at most DUST_MAX_XLM whose sender looks like my own address or like
 * an address I have a real (non-dust) operation with, without being that address.
 */
export function suspiciousOperationKeys(ops: Op[], me: string): Set<string> {
  const isDust = (op: Op) => isNative(op) && amountOf(op) > 0 && amountOf(op) <= DUST_MAX_XLM;
  const trusted = new Set<string>(me ? [me] : []);
  for (const op of ops) {
    if (isDust(op)) continue;
    const other = fromOf(op) === me ? toOf(op) : fromOf(op);
    if (other) trusted.add(other);
  }
  const out = new Set<string>();
  ops.forEach((op, i) => {
    const from = fromOf(op);
    if (toOf(op) !== me || from === me || !isDust(op) || trusted.has(from)) return;
    for (const t of trusted) if (looksAlike(from, t)) { out.add(keyOf(op, i)); return; }
  });
  return out;
}
