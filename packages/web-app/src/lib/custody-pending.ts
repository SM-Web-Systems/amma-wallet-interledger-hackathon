/** One custody payment: a key is reused only for exactly this wallet, destination, amount (base units) and tag. */
export interface SendShape { chain: "xrpl" | "evm"; from: string; to: string; amountBase: string; tag?: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Ethereum addresses are case-insensitive; XRP addresses are not.
const addr = (s: SendShape, a: string) => (s.chain === "evm" ? a.toLowerCase() : a);
export const sendSlot = (s: SendShape): string => `amma.custodySendKey.${s.chain}.${addr(s, s.from)}.${addr(s, s.to)}.${s.amountBase}.${s.tag ?? ""}`;

/** The key of an earlier attempt of this payment whose outcome is not known yet (this tab only), or undefined. */
export function storedSendKey(s: SendShape): string | undefined {
  try { const v = sessionStorage.getItem(sendSlot(s)); return v && UUID.test(v) ? v : undefined; } catch { return undefined; }
}
export function keepSendKey(s: SendShape, key: string): void {
  try { sessionStorage.setItem(sendSlot(s), key); } catch { /* the form still keeps it in memory */ }
}
export function dropSendKey(s: SendShape): void {
  try { sessionStorage.removeItem(sendSlot(s)); } catch { /* nothing to drop */ }
}

/** States after which a new Review may use a new key: the payment went out, or definitely did not. */
const SETTLED = new Set(["broadcast", "confirmed", "failed", "submitted", "validated_success", "validated_failure", "expired", "cancelled"]);
export const isSettled = (r: { state?: unknown; status?: unknown }): boolean => r.status !== "unknown" && typeof r.state === "string" && SETTLED.has(r.state);
