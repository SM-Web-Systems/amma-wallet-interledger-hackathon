import { useCallback, useEffect, useState } from "react";
import { formatTokenBalance, getEvmBalances, getEvmHistory, type EvmBalances, type EvmHistoryItem } from "../lib/eth-server-data";
import { evmExplorerTxUrl } from "../lib/custody-network";

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/** Balances (ETH and tokens) and history of one Amma-held Ethereum wallet, read through Amma's server. */
export function EvmServerData({ address }: { address: string }) {
  const [balances, setBalances] = useState<EvmBalances>();
  const [history, setHistory] = useState<EvmHistoryItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { const b = await getEvmBalances(address); setBalances(b); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : "Balances are not available right now."); }
    finally { setBusy(false); }
  }, [address]);
  const loadHistory = useCallback(async (pageKey?: string | null) => {
    setHistoryError("");
    try { const h = await getEvmHistory(address, pageKey); setHistory((cur) => (pageKey ? [...cur, ...h.transfers] : h.transfers)); setNext(h.pageKey); }
    catch (cause) { setHistoryError(cause instanceof Error && cause.message ? cause.message : "History is not available right now."); }
  }, [address]);

  useEffect(() => { setBalances(undefined); setHistory([]); setNext(null); void load(); void loadHistory(); }, [load, loadHistory]);

  return (
    <section aria-label="Ethereum balances and history" className="ui-card space-y-3 p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Balances</h2>
        <button className="ui-btn-secondary min-h-[44px] px-3" disabled={busy} onClick={() => { void load(); void loadHistory(); }}>Refresh</button>
      </div>
      {error && <p role="alert" className="ui-alert-error">{error}</p>}
      {balances && (
        <ul className="space-y-1 text-sm" data-testid="evm-server-balances">
          <li>ETH: {formatTokenBalance(balances.wei, 18)}</li>
          {balances.tokens.map((t) => (
            <li key={t.contract} className="flex items-center gap-2">
              {t.logo && <img src={t.logo} alt="" width={16} height={16} referrerPolicy="no-referrer" loading="lazy" />}
              <span>{t.symbol ?? "Unknown token"}: {formatTokenBalance(t.balance, t.decimals)}</span>
              {t.name && <span className="text-xs text-stellar-muted">{t.name}</span>}
            </li>
          ))}
          {balances.tokensUnavailable && <li className="text-xs text-stellar-muted">Token balances could not be loaded right now.</li>}
        </ul>
      )}
      <h2 className="pt-2 font-semibold">History</h2>
      {historyError && <p role="alert" className="ui-alert-error">{historyError}</p>}
      {!historyError && history.length === 0 && <p className="text-sm text-stellar-muted">No transfers yet.</p>}
      <ul className="space-y-1 text-sm" data-testid="evm-server-history">
        {history.map((h, i) => (
          <li key={`${h.hash}-${i}`}>
            {h.direction === "in" ? "Received" : "Sent"} {h.value ?? "?"} {h.asset}
            {h.counterparty && <> {h.direction === "in" ? "from" : "to"} <span className="font-mono">{short(h.counterparty)}</span></>}
            {h.timestamp && <> <span className="text-xs text-stellar-muted">{new Date(h.timestamp).toLocaleDateString()}</span></>}
            {" "}<a className="underline" href={`${evmExplorerTxUrl()}${h.hash}`} target="_blank" rel="noreferrer noopener">View</a>
          </li>
        ))}
      </ul>
      {next && <button className="ui-btn-secondary min-h-[44px] px-3" onClick={() => void loadHistory(next)}>Show more</button>}
    </section>
  );
}
