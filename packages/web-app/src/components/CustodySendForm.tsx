import { useCallback, useEffect, useId, useRef, useState } from "react";
import { normalizeAddress } from "@amma-wallet/evm-core";
import {
  dropsToXrp, ethToWei, getXrpPaymentStatus, listCustodyEvmTransfers, sendCustodyEvm, sendCustodyXrp, weiToEth, xrpToDrops,
  XRP_MAX_FEE_DROPS, type EvmTransfer, type SendResult,
} from "../lib/custody-send";
import { dropSendKey, isSettled, keepSendKey, sendSlot, storedSendKey, type SendShape } from "../lib/custody-pending";
import { evmCustodyName, evmCustodyReal, evmExplorerName, evmExplorerTxUrl, xrpExplorerName, xrpExplorerTxUrl } from "../lib/custody-network";
import { formatWei, previewEvmSend, type EvmPreview } from "../lib/eth-server-data";

type Review = { key: string; shape: SendShape; to: string; amount: string; amountBase: string; tag?: number; fee: string; total: string; preview?: EvmPreview | "unavailable" };

const STATUS: Record<string, string> = {
  signed: "Signed, being sent to the network", broadcast: "Sent, waiting for confirmation", confirmed: "Confirmed", failed: "Failed",
  submitted: "Sent, waiting for confirmation", validated_success: "Confirmed", validated_failure: "Failed", expired: "Expired", cancelled: "Cancelled", prepared: "Prepared", awaiting_approval: "Waiting",
};
const btn = "min-h-[44px] px-3";

/** Send from an Amma-held wallet with the account password. Testnet; mainnet in a VITE_MAINNET_CUSTODY=on build (XRP only with VITE_XRPL_MAINNET=on). */
export function CustodySendForm({ chain, from, network, serverPreview = false }: { chain: "xrpl" | "evm"; from: string; /** Ethereum only: the network the server reports for this wallet ("sepolia" or "ethereum"). "ethereum" always means real ETH. */ network?: string; /** Ethereum only: ask Amma's server to simulate the payment and show the result before the password prompt. */ serverPreview?: boolean }) {
  const id = useId();
  const symbol = chain === "evm" ? "ETH" : "XRP";
  const real = chain === "evm" && evmCustodyReal(network);
  const [to, setTo] = useState(""); const [amount, setAmount] = useState(""); const [tag, setTag] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ to?: string; amount?: string; tag?: string }>({});
  const [review, setReview] = useState<Review>();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SendResult>();
  const pwRef = useRef<HTMLInputElement>(null); const errRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (review) pwRef.current?.focus(); }, [review]);
  useEffect(() => { if (error) errRef.current?.focus(); }, [error]);

  // The key of the last attempt whose outcome is not known yet (also in sessionStorage, for a reload). Dropped only once a result is settled,
  // so a Cancel, a new Review or a reload of the same payment reuses it and the server returns the stored payment instead of signing again.
  const unresolved = useRef<{ slot: string; key: string } | null>(null);
  const keyFor = (s: SendShape) => (unresolved.current?.slot === sendSlot(s) ? unresolved.current.key : storedSendKey(s)) ?? crypto.randomUUID();
  const settle = (s: SendShape) => { dropSendKey(s); if (unresolved.current?.slot === sendSlot(s)) unresolved.current = null; };
  const [resultShape, setResultShape] = useState<SendShape>();
  const [transfers, setTransfers] = useState<EvmTransfer[]>([]);
  const loadTransfers = useCallback(async () => {
    if (chain !== "evm") return;
    try { setTransfers((await listCustodyEvmTransfers(from)).slice(0, 5)); } catch { /* the form works without the list */ }
  }, [chain, from]);
  useEffect(() => { void loadTransfers(); }, [loadTransfers]);

  const [previewing, setPreviewing] = useState(false);
  const startReview = async () => {
    setError(""); setResult(undefined);
    const errs: { to?: string; amount?: string; tag?: string } = {};
    const dest = to.trim();
    if (chain === "evm") { try { normalizeAddress(dest); } catch { errs.to = "Enter a valid Ethereum address starting with 0x."; } }
    else if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(dest)) errs.to = "Enter a valid XRP address starting with r.";
    if (!errs.to && dest.toLowerCase() === from.toLowerCase()) errs.to = "You can't send to the same wallet.";
    let r: Review | undefined;
    if (chain === "evm") {
      const wei = ethToWei(amount);
      if (wei === null) errs.amount = "Enter an amount more than 0, with at most 18 decimals and no more than 22 digits before the point.";
      else { const shape: SendShape = { chain, from, to: dest, amountBase: wei.toString() }; r = { key: keyFor(shape), shape, to: dest, amount: weiToEth(wei), amountBase: wei.toString(), fee: "network fee shown after sending", total: `${weiToEth(wei)} ETH plus the network fee` }; }
    } else {
      const drops = xrpToDrops(amount);
      let t: number | undefined;
      if (tag.trim()) { if (/^\d{1,10}$/.test(tag.trim()) && Number(tag) <= 4294967295) t = Number(tag); else errs.tag = "The destination tag must be a whole number up to 4294967295."; }
      if (drops === null) errs.amount = "Enter an amount more than 0, with at most 6 decimals.";
      else { const shape: SendShape = { chain, from, to: dest, amountBase: drops, tag: t }; r = { key: keyFor(shape), shape, to: dest, amount: dropsToXrp(BigInt(drops)), amountBase: drops, tag: t, fee: `up to ${dropsToXrp(XRP_MAX_FEE_DROPS)} XRP`, total: `up to ${dropsToXrp(BigInt(drops) + XRP_MAX_FEE_DROPS)} XRP` }; }
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length || !r) return;
    if (chain === "evm" && serverPreview) {
      // Advisory only: if the preview cannot be fetched the payment can still go ahead, and the screen says it was not simulated.
      setPreviewing(true);
      try { r = { ...r, preview: await previewEvmSend({ from, to: r.to, amountWei: r.amountBase }) }; } catch { r = { ...r, preview: "unavailable" }; } finally { setPreviewing(false); }
    }
    setReview(r); setPassword("");
  };

  const send = async () => {
    if (!review) return;
    setBusy(true); setError("");
    keepSendKey(review.shape, review.key);
    unresolved.current = { slot: sendSlot(review.shape), key: review.key };
    try {
      const res = chain === "evm"
        ? await sendCustodyEvm({ from, to: review.to, amountWei: review.amountBase, password, idempotencyKey: review.key })
        : await sendCustodyXrp({ from, to: review.to, amountDrops: review.amountBase, ...(review.tag !== undefined ? { destinationTag: review.tag } : {}), password, idempotencyKey: review.key });
      if (isSettled(res)) settle(review.shape);
      setResult(res); setResultShape(review.shape); setReview(undefined); setTo(""); setAmount(""); setTag("");
      void loadTransfers();
    } catch (cause) {
      const msg = cause instanceof Error && cause.message ? cause.message : "That did not work. Try again.";
      setError(/too many wrong passwords/i.test(msg) ? "Too many wrong passwords. Try again in 15 minutes." : /already in progress/i.test(msg) ? "Another attempt is still running. Wait a moment and try again." : msg);
    } finally { setPassword(""); setBusy(false); }
  };

  const refresh = async () => {
    try {
      let next: SendResult | undefined;
      if (chain === "xrpl") { if (typeof result?.id === "string") next = { ...result, ...(await getXrpPaymentStatus(result.id)), status: undefined }; }
      else if (result?.hash) {
        const all = await listCustodyEvmTransfers(from);
        setTransfers(all.slice(0, 5));
        const row = all.find((t) => t.hash === result.hash);
        if (row) next = { ...result, state: row.state, status: undefined };
      }
      if (!next) return;
      if (resultShape && isSettled(next)) settle(resultShape);
      setResult(next);
    } catch { /* keep what is shown */ }
  };

  const f = (suffix: string) => `${id}-${suffix}`;
  const bad = (e?: string) => (e ? { "aria-invalid": true as const } : {});
  return (
    <section aria-label={`Send ${symbol}`} className="ui-card space-y-3 p-5">
      <h2 className="font-semibold">Send {chain === "evm" ? evmCustodyName(real) : "XRP"}</h2>
      {!review && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void startReview(); }} noValidate>
          <label className="block text-sm" htmlFor={f("to")}>Send to
            <input id={f("to")} className="ui-field min-h-[44px]" autoComplete="off" spellCheck={false} value={to} onChange={(e) => setTo(e.target.value)} {...bad(fieldErrors.to)} aria-describedby={fieldErrors.to ? f("to-err") : undefined} />
          </label>
          {fieldErrors.to && <p id={f("to-err")} role="alert" className="text-sm text-stellar-danger">{fieldErrors.to}</p>}
          <label className="block text-sm" htmlFor={f("amount")}>Amount ({symbol})
            <input id={f("amount")} className="ui-field min-h-[44px]" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} {...bad(fieldErrors.amount)} aria-describedby={fieldErrors.amount ? f("amount-err") : undefined} />
          </label>
          {fieldErrors.amount && <p id={f("amount-err")} role="alert" className="text-sm text-stellar-danger">{fieldErrors.amount}</p>}
          {chain === "xrpl" && (
            <>
              <label className="block text-sm" htmlFor={f("tag")}>Destination tag (optional)
                <input id={f("tag")} className="ui-field min-h-[44px]" inputMode="numeric" autoComplete="off" value={tag} onChange={(e) => setTag(e.target.value)} {...bad(fieldErrors.tag)} aria-describedby={fieldErrors.tag ? f("tag-err") : undefined} />
              </label>
              {fieldErrors.tag && <p id={f("tag-err")} role="alert" className="text-sm text-stellar-danger">{fieldErrors.tag}</p>}
            </>
          )}
          <button type="submit" className={`ui-btn-primary ${btn}`} disabled={previewing || !to.trim() || !amount.trim()}>{previewing ? "Checking…" : "Review"}</button>
        </form>
      )}
      {review && (
        <form className="space-y-2 rounded bg-stellar-dark p-3 text-sm" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <p>To <span className="break-all font-mono">{review.to}</span></p>
          {review.tag !== undefined && <p>Destination tag {review.tag}</p>}
          {real && <p><span className="ui-chip">Real ETH</span></p>}
          <p>Amount {review.amount} {symbol}</p>
          <p>Maximum network fee: {review.fee}</p>
          <p className="font-semibold">Total: {review.total}</p>
          {review.preview && (
            <div className="space-y-1 rounded border border-stellar-border p-2" aria-label="Payment preview">
              <p className="font-semibold">What will happen</p>
              {review.preview === "unavailable" ? <p>We couldn't check this payment right now. It was not simulated.</p> : (
                <>
                  <ul>{review.preview.changes.map((c, i) => <li key={i}>{c.direction === "out" ? "Leaves your wallet" : c.direction === "in" ? "Comes into your wallet" : "Moves between others"}: {c.amount} {c.asset}</li>)}</ul>
                  {formatWei(review.preview.gasEstimateWei) && <p>Estimated network fee: about {formatWei(review.preview.gasEstimateWei)} ETH</p>}
                  {review.preview.warnings.map((w, i) => <p key={i} role="alert" className="ui-alert-warn">{w}</p>)}
                </>
              )}
            </div>
          )}
          <label className="block" htmlFor={f("pw")}>Your Amma password
            <input ref={pwRef} id={f("pw")} className="ui-field min-h-[44px]" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} {...bad(error)} aria-describedby={error ? f("err") : undefined} />
          </label>
          {error && <p id={f("err")} ref={errRef} tabIndex={-1} role="alert" className="ui-alert-error">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className={`ui-btn-primary ${btn}`} disabled={busy || !password}>{busy ? "Sending…" : "Approve and send"}</button>
            <button type="button" className={`ui-btn-ghost ${btn}`} disabled={busy} onClick={() => { setReview(undefined); setError(""); setPassword(""); }}>Cancel</button>
          </div>
        </form>
      )}
      {result && (
        <div role="status" className="space-y-1 text-sm">
          {result.status === "unknown" && <p className="ui-alert-warn">{typeof result.error === "string" ? result.error : chain === "evm" ? "We could not confirm that this payment was sent. Check the list below before trying again." : "We could not confirm that this payment was sent. Check its status before trying again."}</p>}
          <p>Status: {STATUS[result.state] ?? result.state}</p>
          {result.hash && <p><a className="underline" target="_blank" rel="noreferrer noopener" href={`${chain === "evm" ? evmExplorerTxUrl() : xrpExplorerTxUrl()}${result.hash}`}>View on the {chain === "evm" ? evmExplorerName() : xrpExplorerName()} explorer</a></p>}
          {((chain === "evm" && result.hash) || (chain === "xrpl" && typeof result.id === "string")) && <button type="button" className={`ui-btn-secondary ${btn}`} onClick={() => void refresh()}>Refresh status</button>}
        </div>
      )}
      {chain === "evm" && transfers.length > 0 && (
        <section aria-label="Recent transfers" className="space-y-1 text-sm">
          <h3 className="font-semibold">Recent transfers</h3>
          <ul className="space-y-1">
            {transfers.map((t) => (
              <li key={t.id}>
                {weiToEth(BigInt(t.amountWei))} ETH to <span className="font-mono">{t.to.slice(0, 10)}…</span>: {STATUS[t.state] ?? t.state}{" "}
                <a className="underline" target="_blank" rel="noreferrer noopener" href={`${evmExplorerTxUrl()}${t.hash}`}>{t.hash.slice(0, 10)}…</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
