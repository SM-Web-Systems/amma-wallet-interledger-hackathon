// Can the wallet pay what the review says it will pay (amount plus the Amma fee)? Stroop maths, no floats.

const ONE = 10_000_000n;
const toStroops = (s: unknown): bigint => {
  const [w, f = ""] = String(s ?? "0").split(".");
  const whole = BigInt(/^-?\d+$/.test(w || "0") ? w || "0" : "0");
  return whole * ONE + BigInt((f + "0000000").slice(0, 7).replace(/\D/g, "0") || "0");
};
const fromStroops = (n: bigint): string => {
  const v = n < 0n ? 0n : n;
  return `${v / ONE}.${(v % ONE).toString().padStart(7, "0")}`;
};
const keyOf = (asset: string, issuer?: string) => (asset === "XLM" && !issuer ? "XLM" : `${asset}:${issuer ?? ""}`);

type Account = { balances?: unknown; subentry_count?: unknown; num_sponsoring?: unknown; num_sponsored?: unknown } | null | undefined;

/**
 * What the account can spend per asset ("XLM" or "CODE:ISSUER"), in stroops: XLM keeps the minimum reserve
 * (0.5 XLM x (2 + subentries + sponsoring - sponsored)) and selling liabilities; tokens keep selling liabilities.
 * null when the account carries no balances (then nothing can be checked, and nothing is blocked).
 */
export function spendableByAsset(account: Account): Map<string, bigint> | null {
  const balances = (account as { balances?: unknown } | null)?.balances;
  if (!Array.isArray(balances)) return null;
  const a = account as Record<string, unknown>;
  const entries = 2n + BigInt(Number(a.subentry_count ?? 0) || 0) + BigInt(Number(a.num_sponsoring ?? 0) || 0) - BigInt(Number(a.num_sponsored ?? 0) || 0);
  const out = new Map<string, bigint>();
  for (const b of balances as Record<string, unknown>[]) {
    const free = toStroops(b.balance) - toStroops(b.selling_liabilities);
    if (b.asset_type === "native") out.set("XLM", free - entries * (ONE / 2n));
    else if (typeof b.asset_code === "string" && typeof b.asset_issuer === "string") out.set(keyOf(b.asset_code, b.asset_issuer), free);
  }
  return out;
}

export type Shortfall = { asset: string; need: string; have: string; max?: string; isSendAsset: boolean };

/**
 * The first asset whose total (from the server's fee quote, amount plus fee) is more than the wallet can spend, or null.
 * For the asset being sent, `max` is the largest amount that still leaves room for the fee.
 */
export function affordability(
  pays: { asset: string; issuer?: string; amount: string }[],
  spendable: Map<string, bigint>,
  sending: { asset: string; issuer?: string; amount: string },
  /** The network fee in stroops when the user pays it (Amma did not fee-bump); it comes off the spendable XLM. */
  networkFeeStroops = 0n,
): Shortfall | null {
  const sendKey = keyOf(sending.asset, sending.issuer);
  for (const p of pays) {
    const k = keyOf(p.asset, p.issuer);
    const need = toStroops(p.amount);
    const have = (spendable.get(k) ?? 0n) - (k === "XLM" ? networkFeeStroops : 0n);
    if (need <= have) continue;
    if (k === sendKey) {
      const fee = need - toStroops(sending.amount);
      return { asset: p.asset, need: fromStroops(need), have: fromStroops(have), max: fromStroops(have - fee), isSendAsset: true };
    }
    return { asset: p.asset, need: fromStroops(need), have: fromStroops(have), isSendAsset: false };
  }
  return null;
}
