import type { FundingAdapter } from "./service";

/** Stellar testnet Friendbot: 10000 XLM per new account. Response bodies are never kept. */
export function stellarFriendbot(fetchFn: typeof fetch = fetch): FundingAdapter {
  return {
    chain: "stellar",
    async fund(address) {
      const res = await fetchFn(`https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error("faucet-unavailable");
      const body = (await res.json().catch(() => ({}))) as { hash?: unknown };
      return { amount: "10000 XLM", reference: typeof body.hash === "string" ? body.hash : "" };
    },
  };
}
