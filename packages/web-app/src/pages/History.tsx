import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { txApi } from "../lib/api";
import { useWalletStore } from "../store/wallet";
import TxDetailDialog from "../components/TxDetailDialog";
import { explorerTxUrl, hasOperationId } from "../lib/stellar-tx-details";
import { keyOf, suspiciousOperationKeys } from "../lib/address-poisoning";
import { ArrowUpRight, ArrowDownLeft, UserPlus, Link as LinkIcon, Settings, Loader2, ExternalLink, ShieldAlert } from "lucide-react";

function unwrap(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.records)) return raw.records;
  if (Array.isArray(raw.data)) return raw.data;
  if (raw._embedded && Array.isArray(raw._embedded.records)) return raw._embedded.records;
  return [];
}

function getOpIcon(type: string, isSent: boolean) {
  switch (type) {
    case "create_account": return <UserPlus size={16} className="text-stellar-link" />;
    case "change_trust": return <LinkIcon size={16} className="text-stellar-purple" />;
    case "set_options": case "manage_data": return <Settings size={16} className="text-stellar-muted" />;
    default: return isSent ? <ArrowUpRight size={16} className="text-stellar-danger-text" /> : <ArrowDownLeft size={16} className="text-stellar-success-text" />;
  }
}

export default function HistoryPage() {
  const { t } = useTranslation();
  const publicKey = useWalletStore((s) => s.accounts.find((a) => a.id === s.activeAccountId)?.publicKey ?? null)!;
  const [limit] = useState(20);
  const network = useWalletStore((s) => s.network);
  const [params, setParams] = useSearchParams();
  const [picked, setPicked] = useState<string | null>(null);
  const detailHash = picked ?? (/^[0-9a-f]{64}$/i.test(params.get("tx") ?? "") ? params.get("tx") : null);
  const closeDetail = () => { setPicked(null); if (params.has("tx")) { const n = new URLSearchParams(params); n.delete("tx"); setParams(n, { replace: true }); } };

  const { data: raw, isLoading, error, refetch, isFetching } = useQuery<any>({ queryKey: ["tx-history", publicKey, limit], queryFn: () => txApi.history(publicKey, limit), enabled: !!publicKey, refetchInterval: 30_000 });
  const operations = unwrap(raw);
  // Tiny incoming payments from look-alike addresses (address poisoning) are hidden unless the person asks to see them.
  const [showSuspicious, setShowSuspicious] = useState(false);
  const suspicious = suspiciousOperationKeys(operations, publicKey);

  function getOpLabel(type: string, isSent: boolean): string {
    switch (type) {
      case "create_account": return isSent ? t("history.createdAccount") : t("history.accountFunded");
      case "payment": return isSent ? t("history.sent") : t("history.received");
      case "path_payment_strict_receive": case "path_payment_strict_send": return isSent ? t("history.swapSent") : t("history.swapReceived");
      case "change_trust": return t("history.trustlineChanged");
      case "manage_sell_offer": case "manage_buy_offer": return t("history.dexOffer");
      case "set_options": return t("history.accountUpdated");
      case "manage_data": return t("history.dataUpdated");
      default: return type.replace(/_/g, " ");
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-stellar-text">{t("history.title")}</h1>

      {error && (
        <div role="alert" className="ui-alert-error space-y-3">
          <p>{t("history.loadError", "We could not load your history. Your funds are safe. Check your connection and try again.")}</p>
          <button type="button" onClick={() => { void refetch(); }} disabled={isFetching} className="ui-btn-secondary">
            {isFetching && <Loader2 className="animate-spin" size={16} aria-hidden="true" />}
            {isFetching ? t("history.retrying", "Trying again...") : t("history.retry", "Try again")}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="animate-spin text-stellar-muted" size={32} /></div>
      ) : operations.length === 0 && !error ? (
        <div className="text-center py-12 space-y-3">
          <p className="text-stellar-text font-medium">{t("history.noTransactions")}</p>
          <p className="text-sm text-stellar-muted">{t("history.emptyNext", "Money you receive will appear here.")}</p>
          <Link to="/receive" className="ui-btn-primary">{t("nav.receive")}</Link>
        </div>
      ) : (
        <div className="space-y-2">
          {suspicious.size > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-stellar-warning/30 bg-stellar-warning/10 px-4 py-3 text-xs text-stellar-text" role="note">
              <ShieldAlert size={16} className="shrink-0 text-stellar-warning" aria-hidden="true" />
              <p className="flex-1">
                {t("history.suspiciousHidden", { count: suspicious.size, defaultValue: suspicious.size === 1 ? "1 suspicious tiny payment hidden." : "{{count}} suspicious tiny payments hidden." })}{" "}
                {t("history.suspiciousWhy", "They come from addresses made to look like ones you use. Never copy an address from them.")}
              </p>
              <button type="button" onClick={() => setShowSuspicious((v) => !v)} className="min-h-[44px] px-2 text-stellar-link hover:underline">
                {showSuspicious ? t("history.hideSuspicious", "Hide") : t("history.showSuspicious", "Show")}
              </button>
            </div>
          )}
          {operations.map((op: any, index: number) => {
            const isSuspicious = suspicious.has(keyOf(op, index));
            if (isSuspicious && !showSuspicious) return null;
            const from = op.from || op.sourceAccount || op.source_account || op.funder || "";
            const to = op.to || op.account || "";
            const isSent = from === publicKey;
            const amount = op.amount || op.startingBalance || op.starting_balance || "";
            const assetCode = op.assetCode || op.asset_code || (op.assetType === "native" || op.asset_type === "native" ? "XLM" : "");
            const type = op.type || "unknown";
            const hash = op.transactionHash || op.transaction_hash || op.hash || "";
            const createdAt = op.createdAt || op.created_at || "";
            const counterparty = isSent ? to : from;
            const hasAmount = amount && parseFloat(amount) > 0;

            return (
              <div key={op.id || hash || index} className="flex items-center justify-between bg-stellar-card border border-stellar-border rounded-xl px-5 py-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`p-2 rounded-full shrink-0 ${type === "create_account" ? "bg-stellar-blue/20" : type === "change_trust" ? "bg-stellar-purple/20" : isSent ? "bg-stellar-danger/20" : "bg-stellar-success/20"}`}>
                    {getOpIcon(type, isSent)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stellar-text">{getOpLabel(type, isSent)}{hasAmount && assetCode ? ` ${assetCode}` : ""}</p>
                    <div className="flex items-center gap-2 text-xs text-stellar-muted">
                      {createdAt && (<span>{new Date(createdAt).toLocaleString()}</span>)}
                      {counterparty && (<><span>·</span><span className="font-mono truncate max-w-[120px]">{counterparty.slice(0, 6)}...{counterparty.slice(-6)}</span></>)}
                    </div>
                    {isSuspicious && (
                      <p className="text-xs font-medium text-stellar-danger-text">{t("history.possibleFake", "Possible fake address: do not copy or pay it")}</p>
                    )}
                    {op.id && hasOperationId({ id: String(op.id), type }) && (
                      <p className="text-xs text-stellar-muted break-all">{t("txDetail.operationId", "Operation ID")}: <span className="font-mono select-all">{String(op.id)}</span></p>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0 ml-4">
                  {hasAmount ? (
                    <p className={`font-mono text-sm ${type === "change_trust" ? "text-stellar-purple" : isSent ? "text-stellar-danger-text" : "text-stellar-success-text"}`}>
                      {isSent ? "-" : "+"}{parseFloat(amount).toLocaleString(undefined, { maximumFractionDigits: 7 })}
                    </p>
                  ) : (<p className="text-xs text-stellar-muted">{type.replace(/_/g, " ")}</p>)}
                  {hash && (
                    <div className="flex flex-col items-end">
                      <button type="button" onClick={() => setPicked(hash)} className="min-h-[44px] px-2 text-xs text-stellar-link hover:underline">
                        {t("txDetail.details", "Details")}<span className="sr-only"> {getOpLabel(type, isSent)} {createdAt ? new Date(createdAt).toLocaleString() : ""}</span>
                      </button>
                      <a href={explorerTxUrl(network, hash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-stellar-link hover:underline">
                        {t("history.view")} <ExternalLink size={10} />
                      </a>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isLoading && !error && operations.length > 0 && (
        <p className="text-xs text-stellar-muted text-center">
          {t("common.showing", { count: operations.length, item: operations.length !== 1 ? t("common.operations") : t("common.operation") })}
        </p>
      )}
      {detailHash && <TxDetailDialog hash={detailHash} network={network} onClose={closeDetail} />}
    </div>
  );
}
