import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  explorerTxUrl, fetchTxDetailsWithRetry, hasOperationId, historyDetailPath,
  type StellarNetwork, type TxDetails,
} from "../lib/stellar-tx-details";

export type KnownSend = { amount: string; assetCode: string; destination: string; memoType: string; memo: string };

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const utc = (iso: string) => iso.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");
const memoTypeLabel = (t: string) => (t === "none" ? "" : t.charAt(0).toUpperCase() + t.slice(1));

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="py-2 border-b border-stellar-border last:border-0">
      <dt className="text-xs text-stellar-muted">{label}</dt>
      <dd className="text-sm text-stellar-text break-all">{children}</dd>
    </div>
  );
}

function CopyValue({ value, label, mono = true }: { value: string; label: string; mono?: boolean }) {
  const { t } = useTranslation();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("txDetail.copied", "Copied"));
    } catch {
      toast.error(t("txDetail.copyFailed", "Could not copy. Select the text and copy it manually."));
    }
  };
  return (
    <span className="flex items-start gap-2">
      <span className={`${mono ? "font-mono" : ""} select-all min-w-0 flex-1 break-all`}>{value}</span>
      <button type="button" onClick={copy} aria-label={label} title={label} className="ui-btn ui-btn-ghost shrink-0 min-h-[44px] min-w-[44px] inline-flex items-center justify-center">
        <Copy size={14} aria-hidden="true" />
      </button>
    </span>
  );
}

/**
 * What happened to a Stellar transaction: amount, asset, destination, memo, hash, ledger, time, fee and the
 * operation ID of each payment. Used right after a send (with a link to History) and in the History detail dialog.
 */
export default function TxConfirmation({
  hash, network, known, showHistoryLink = true, headingRef, titleId,
}: {
  hash: string;
  network: StellarNetwork;
  known?: KnownSend;
  showHistoryLink?: boolean;
  headingRef?: React.Ref<HTMLHeadingElement>;
  titleId?: string;
}) {
  const { t } = useTranslation();
  const [details, setDetails] = useState<TxDetails | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "pending">("loading");
  const [tries, setTries] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    // Horizon needs a few seconds to ingest a new ledger; the lookup retries a bounded number of times.
    fetchTxDetailsWithRetry(network, hash, { signal: ac.signal, attempts: 6, delayMs: 2000 })
      .then((d) => { if (ac.signal.aborted) return; setDetails(d); setState(d ? "loaded" : "pending"); })
      .catch(() => { if (!ac.signal.aborted) setState("pending"); });
    return () => ac.abort();
  }, [hash, network, tries]);

  const again = useCallback(() => { setState("loading"); setTries((n) => n + 1); }, []);
  const link = explorerTxUrl(network, hash);
  const d = state === "loaded" ? details : null;

  return (
    <section aria-labelledby={titleId ?? "tx-confirmation-title"} className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-3 max-w-lg">
      <h2 id={titleId ?? "tx-confirmation-title"} ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-stellar-text focus:outline-none">
        {t("txDetail.title", "Transaction details")}
      </h2>

      {state === "loading" && (
        <p role="status" className="flex items-center gap-2 text-sm text-stellar-muted">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />{t("txDetail.confirming", "Confirming…")}
        </p>
      )}
      {state === "pending" && (
        <div role="status" className="ui-alert ui-alert-warn text-sm">
          {t("txDetail.notYet", "This transaction is not on Horizon yet. It was submitted; the details below are what is known.")}{" "}
          <button type="button" onClick={again} className="underline min-h-[44px]">{t("txDetail.checkAgain", "Check again")}</button>
        </div>
      )}
      {d && !d.successful && <p role="alert" className="text-sm text-stellar-danger-text">{t("txDetail.failed", "This transaction failed on the network.")}</p>}

      <dl>
        {d ? (
          <>
            {d.operations.map((op, i) => op.platformFee ? (
              <Row key={op.id || i} label={t("txDetail.platformFee", "Network/platform fee (paid by Amma)")}>{op.amount} {op.assetCode}</Row>
            ) : (
              <div key={op.id || i} className="border-b border-stellar-border last:border-0">
                {hasOperationId(op) && (
                  <Row label={t("txDetail.operationId", "Operation ID")}><CopyValue value={op.id} label={t("txDetail.copyOp", "Copy operation ID")} /></Row>
                )}
                {op.amount && (
                  <Row label={t("txDetail.amount", "Amount")}>
                    {op.amount} {op.assetCode}
                    {op.assetIssuer && <span className="block text-xs text-stellar-muted font-mono" title={op.assetIssuer}>{t("txDetail.issuer", "issuer")} {short(op.assetIssuer)}</span>}
                    {op.sourceAmount && <span className="block text-xs text-stellar-muted">{t("txDetail.spent", "paid")} {op.sourceAmount} {op.sourceAssetCode}</span>}
                  </Row>
                )}
                {op.destination && (
                  <Row label={t("txDetail.destination", "Destination")}><CopyValue value={op.destination} label={t("txDetail.copyDest", "Copy destination")} /></Row>
                )}
              </div>
            ))}
            <Row label={t("txDetail.memo", "Memo")}>
              {d.memo.type === "none" ? t("send.noMemo", "No memo") : (
                <>
                  <span className="block text-xs text-stellar-muted">{memoTypeLabel(d.memo.type)}</span>
                  <CopyValue value={d.memo.value} label={t("txDetail.copyMemo", "Copy memo")} mono={d.memo.type !== "text"} />
                </>
              )}
            </Row>
          </>
        ) : known && (
          <>
            <Row label={t("txDetail.amount", "Amount")}>{known.amount} {known.assetCode}</Row>
            <Row label={t("txDetail.destination", "Destination")}><CopyValue value={known.destination} label={t("txDetail.copyDest", "Copy destination")} /></Row>
            {known.memo && <Row label={t("txDetail.memo", "Memo")}><span className="block text-xs text-stellar-muted">{memoTypeLabel(known.memoType)}</span>{known.memo}</Row>}
          </>
        )}
        <Row label={d?.feeBump ? t("txDetail.outerHash", "Outer (fee-bump) transaction hash") : t("txDetail.hash", "Transaction hash")}><CopyValue value={hash} label={t("txDetail.copyHash", "Copy transaction hash")} /></Row>
        {d?.feeBump && (
          <Row label={t("txDetail.innerHash", "Inner transaction hash")}><CopyValue value={d.feeBump.innerHash} label={t("txDetail.copyInnerHash", "Copy inner transaction hash")} /></Row>
        )}
        {d && (
          <>
            {d.ledger != null && <Row label={t("txDetail.ledger", "Ledger")}>{d.ledger}</Row>}
            {d.createdAt && (
              <Row label={t("txDetail.time", "Time")}>
                <span className="block">{new Date(d.createdAt).toLocaleString()}</span>
                <span className="block text-xs text-stellar-muted">{utc(d.createdAt)}</span>
              </Row>
            )}
            <Row label={t("txDetail.fee", "Fee")}>
              {d.feeXlm} XLM
              {d.feeBump && <span className="block text-xs text-stellar-muted">{t("txDetail.feeBump", "Fee bump; inner transaction")} <span className="font-mono">{short(d.feeBump.innerHash)}</span></span>}
            </Row>
          </>
        )}
      </dl>

      <div className="flex flex-wrap gap-4 text-sm">
        <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 min-h-[44px] text-stellar-link hover:underline">
          {t("txDetail.explorer", "View on stellar.expert")} <ExternalLink size={12} aria-hidden="true" />
        </a>
        {showHistoryLink && (
          <Link to={historyDetailPath(hash)} className="inline-flex items-center min-h-[44px] text-stellar-link hover:underline">
            {t("txDetail.history", "Find this later in History")}
          </Link>
        )}
      </div>
    </section>
  );
}
