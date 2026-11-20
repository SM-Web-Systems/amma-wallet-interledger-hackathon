/**
 * What a balance screen should show (G-16). A failed load must never look like an empty wallet:
 * "error" means we could not read the account, "unfunded" means we read it and it holds nothing.
 * When a refresh fails after a good load, the last known balances stay on screen and `stale` is true.
 */
export type BalanceViewState = "loading" | "error" | "unfunded" | "ready";

export function balanceView(q: {
  isLoading: boolean;
  isError: boolean;
  data?: readonly unknown[] | null;
}): { state: BalanceViewState; stale: boolean } {
  if (q.data && q.data.length > 0) return { state: "ready", stale: q.isError };
  if (q.isLoading) return { state: "loading", stale: false };
  if (q.isError) return { state: "error", stale: false };
  return { state: "unfunded", stale: false };
}

/**
 * Testnet reads the backend first. The backend answers an account Horizon does not know yet with an error,
 * so on failure ask Horizon, which says "not found" (an empty, unfunded account) or fails too.
 */
export async function firstThatWorks<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch {
    return fallback();
  }
}
