import type { FundingAdapter } from "./service";

/** XRPL testnet faucet. Response bodies are never kept, only the amount and the transaction hash. */
export function xrplFaucet(fetchFn: typeof fetch = fetch): FundingAdapter {
  return {
    chain: "xrpl",
    async fund(address) {
      const res = await fetchFn("https://faucet.altnet.rippletest.net/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ destination: address }), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error("faucet-unavailable");
      const body = (await res.json().catch(() => ({}))) as { amount?: unknown; transactionHash?: unknown; hash?: unknown };
      const ref = body.transactionHash ?? body.hash;
      return { amount: body.amount != null ? String(body.amount).slice(0, 40) : "testnet XRP", reference: typeof ref === "string" ? ref : "" };
    },
  };
}
