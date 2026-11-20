import { useTranslation } from "react-i18next";
import { useWalletStore } from "../../shared/store/wallet";
import { useBalances } from "../../shared/hooks/useBalances";
import TokenIcon from "../../shared/components/TokenIcon";
import { Copy, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import { balanceView } from "../../shared/lib/balance-view";
import { toast } from "sonner";

export default function Dashboard() {
  const { t } = useTranslation();
  const publicKey = useWalletStore(
    (s) => s.accounts.find((a) => a.id === s.activeAccountId)?.publicKey ?? ""
  );
  const { data: balances, isLoading, isError, refetch, isFetching } = useBalances();
  const view = balanceView({ isLoading, isError, data: balances });

  const xlmBalance = balances?.find(
    (b) => b.assetCode === "XLM" && (b.assetType === "native" || !b.assetIssuer)
  );

  const copyAddress = () => {
    navigator.clipboard.writeText(publicKey);
    toast.success(t("common.copied"));
  };

  return (
    <div className="p-4 space-y-4">
      {/* Address */}
      <div
        onClick={copyAddress}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-stellar-card border border-stellar-border cursor-pointer hover:border-stellar-blue transition-colors"
      >
        <span className="text-xs text-stellar-muted truncate flex-1 font-mono">
          {publicKey}
        </span>
        <Copy size={14} className="text-stellar-muted shrink-0" />
      </div>

      {/* XLM Balance */}
      <div className="text-center py-4">
        <p className="text-3xl font-bold text-white">
          {view.state === "error" || view.state === "loading" ? "—" : xlmBalance ? parseFloat(xlmBalance.balance).toFixed(2) : "0.00"}
        </p>
        <p className="text-sm text-stellar-muted">XLM</p>
      </div>

      {/* Assets */}
      <div>
        <h3 className="text-sm font-semibold text-white mb-2">
          {t("dashboard.yourAssets")}
        </h3>

        {view.stale && (
          <div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-white">
            <span>{t("dashboard.staleBalance", "Could not refresh. These are your last known balances and may be out of date.")}</span>
            <button type="button" onClick={() => void refetch()} disabled={isFetching} className="shrink-0 font-medium text-stellar-link disabled:opacity-50">{t("common.retry", "Retry")}</button>
          </div>
        )}

        {view.state === "loading" ? (
          <div className="flex justify-center py-8">
            <Loader2 className="animate-spin text-stellar-link" size={24} />
          </div>
        ) : view.state === "error" ? (
          <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-6 text-center">
            <p className="text-sm font-medium text-white">{t("dashboard.loadFailed", "Could not load your balance.")}</p>
            <p className="mt-1 text-xs text-stellar-muted">{t("dashboard.loadFailedHint", "Your funds are safe. Check your connection and try again.")}</p>
            <button type="button" onClick={() => void refetch()} disabled={isFetching} className="mt-3 rounded-lg bg-stellar-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-stellar-purple disabled:opacity-50">{t("common.retry", "Retry")}</button>
          </div>
        ) : view.state === "unfunded" ? (
          <div className="text-center py-8">
            <p className="text-sm text-stellar-muted">{t("dashboard.noAssets")}</p>
            <Link to="/receive" className="mt-3 inline-block rounded-lg bg-stellar-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-stellar-purple">{t("nav.receive")}</Link>
          </div>
        ) : (
          <div className="space-y-1">
            {(balances ?? []).map((b) => {
              const code = b.assetCode || "XLM";
              const issuer = b.assetIssuer || "native";
              return (
                <Link
                  key={`${code}-${issuer}`}
                  to={`/tokens/${encodeURIComponent(code)}/${encodeURIComponent(issuer)}`}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <TokenIcon
                    code={code}
                    image={b.token?.tomlImage}
                    size={32}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white">{code}</p>
                    <p className="text-xs text-stellar-muted truncate">
                      {b.token?.tomlName ||
                        b.token?.domain ||
                        (issuer === "native"
                          ? t("dashboard.stellarLumens")
                          : issuer.slice(0, 8) + "…")}
                    </p>
                  </div>
                  <p className="text-sm text-white font-medium">
                    {parseFloat(b.balance).toFixed(
                      parseFloat(b.balance) > 1000 ? 0 : 2
                    )}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}