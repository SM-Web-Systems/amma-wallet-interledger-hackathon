import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useBalances } from "../hooks/useBalances";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";
import TokenIcon from "../components/TokenIcon";
import { ArrowDownLeft, ArrowLeftRight, Check, CheckCircle2, Copy, Send, Store, X } from "lucide-react";
import { getAccessToken } from "../lib/api";
import { balanceView } from "../lib/balance-view";
import { BalanceState } from "../components/kit/BalanceState";
import { useActivation } from "../hooks/useActivation";
import { LMS_URL } from "../lib/activation";

export default function DashboardPage() {
  const { t } = useTranslation();
  const publicKey = useWalletStore(
    (s) => s.accounts.find((a) => a.id === s.activeAccountId)?.publicKey ?? null
  );
  const network = useWalletStore((s) => s.network);
  const [copied, setCopied] = useState(false);
  const { data: balances, isLoading, isError, refetch, isFetching } = useBalances();
  const view = balanceView({ isLoading, isError, data: balances });
  const activation = useActivation(publicKey);
  const copyAddress = () => {
    if (!publicKey) return;
    void navigator.clipboard.writeText(publicKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  const actions = [
    { to: "/send", label: t("nav.send"), icon: Send },
    { to: "/receive", label: t("nav.receive"), icon: ArrowDownLeft },
    ...(import.meta.env.VITE_PAYMENTS_ENABLED === "true" ? [{ to: "/payments", label: t("nav.pay", "Pay shop"), icon: Store }] : []),
    { to: "/swap", label: t("nav.swap"), icon: ArrowLeftRight },
  ];
  const totalXlm = balances?.find((b) => b.assetCode === "XLM")?.balance || "0";

  const user = useAuthStore((s) => s.user);
  const [showFundingNotice, setShowFundingNotice] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    const dismissKey = `amma_funding_notice_dismissed_${user.id}`;
    if (localStorage.getItem(dismissKey)) return;
    const token = getAccessToken();
    if (!token) return;
    fetch("/api/v1/wallet/funding-notice", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((body) => { if (body.hasFundingEvent) setShowFundingNotice(true); })
      .catch(() => {});
  }, [user?.id]);

  const handleDismissFunding = () => {
    if (user?.id) localStorage.setItem(`amma_funding_notice_dismissed_${user.id}`, "1");
    setShowFundingNotice(false);
  };

  return (
    <div className="space-y-8">
      {showFundingNotice && (
        <div data-testid="funding-notice" className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-4 flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-800 dark:text-emerald-400">
            <CheckCircle2 size={18} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-stellar-text">{t("dashboard.fundingNoticeTitle", "Your wallet is active")}</p>
            <p className="text-xs text-stellar-muted mt-0.5 leading-relaxed">
              {activation?.activatedBy
                ? t("dashboard.fundingNoticeBodyPartner", "Thanks to {{partner}}, you can now receive payments and rewards.", { partner: activation.activatedBy })
                : t("dashboard.fundingNoticeBody", "You can now receive payments and rewards.")}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismissFunding}
            className="shrink-0 p-1 rounded text-stellar-muted hover:text-stellar-text transition-colors"
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}

      <div>
        <h1 className="text-2xl font-bold text-stellar-text">{t("dashboard.title")}</h1>
        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
          {publicKey && (
            <button
              type="button"
              onClick={copyAddress}
              title={publicKey}
              aria-label={copied ? "Address copied" : "Copy wallet address"}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -ml-1.5 text-sm text-stellar-muted font-mono hover:bg-stellar-text/5 hover:text-stellar-text transition-colors"
            >
              {publicKey.slice(0, 6)}…{publicKey.slice(-6)}
              {copied ? <Check size={14} className="text-emerald-500" aria-hidden /> : <Copy size={14} aria-hidden />}
            </button>
          )}
          {network === "testnet" ? (
            <span data-testid="network-badge" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-amber-500/20 text-amber-800 dark:text-amber-300 font-medium shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              Testnet
            </span>
          ) : (
            <span data-testid="network-badge" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded bg-emerald-500/20 text-emerald-800 dark:text-emerald-400 font-medium shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Mainnet
            </span>
          )}
        </div>
      </div>

      <div className="ui-hero relative overflow-hidden p-6 sm:p-8">
        <svg aria-hidden className="pointer-events-none absolute -right-6 -top-6 h-40 w-40 text-marigold-400/25" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c.6 6.2 5.8 11.4 12 12-6.2.6-11.4 5.8-12 12-.6-6.2-5.8-11.4-12-12C6.2 11.4 11.4 6.2 12 0Z" /></svg>
        <p className="relative text-sm text-white/75">{t("dashboard.totalBalance")}</p>
        <p data-testid="total-balance" className="relative mt-2 text-3xl sm:text-5xl font-semibold tracking-tight text-white break-words tabular-nums">
          {view.state === "error" || view.state === "loading" ? "—" : parseFloat(totalXlm).toLocaleString(undefined, { maximumFractionDigits: 4 })} <span className="text-xl sm:text-2xl font-medium text-white/70">XLM</span>
        </p>
        <nav aria-label="Quick actions" className={`relative mt-6 grid gap-2 sm:gap-3 ${actions.length === 4 ? "grid-cols-4" : "grid-cols-3"}`}>
          {actions.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex flex-col items-center gap-1.5 rounded-xl bg-white/10 border border-white/15 px-2 py-3 text-xs sm:text-sm font-medium text-white hover:bg-white/15 transition-colors"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-jade-800">
                <Icon size={17} aria-hidden />
              </span>
              <span className="max-w-full text-center leading-tight break-words">{label}</span>
            </Link>
          ))}
        </nav>
      </div>

      <div>
        <h2 className="text-lg font-semibold text-stellar-text mb-4">{t("dashboard.yourAssets")}</h2>
        <BalanceState
          state={view.state}
          stale={view.stale}
          activation={activation && { state: activation.state, partner: activation.activatedBy ?? null }}
          onRetry={() => void refetch()}
          retrying={isFetching}
          receiveHref="/receive"
          labels={{
            loadFailed: t("dashboard.loadFailed", "Could not load your balance."),
            loadFailedHint: t("dashboard.loadFailedHint", "Your funds are safe. Check your connection and try again."),
            retry: t("common.retry", "Retry"),
            stale: t("dashboard.staleBalance", "Could not refresh. These are your last known balances and may be out of date."),
            empty: t("dashboard.noAssets"),
            receive: t("nav.receive"),
            loading: t("common.loading", "Loading"),
            activation: {
              notActivated: t("dashboard.notActivated", "Your wallet is not active yet. Finish your first task with the partner that sent you here, for example a course in the LMS. We then switch it on."),
              activating: t("dashboard.activating", "Activating… This usually takes under a minute."),
              delayed: t("dashboard.activationDelayed", "Activation is taking longer than usual. We will keep trying."),
              failed: t("dashboard.activationFailed", "Activation did not go through. The partner has been told and nothing was charged."),
              goToPartner: { label: t("dashboard.goToLms", "Go to the LMS"), href: LMS_URL },
              active: (partner: string | null) => (partner ? t("dashboard.activatedBy", "Active – activated by {{partner}}", { partner }) : t("dashboard.active", "Active")),
            },
          }}
        >
          <div className="space-y-2">
            {(balances ?? []).map((b) => (
              <Link
                key={`${b.assetCode}-${b.assetIssuer}`}
                to={`/tokens/${encodeURIComponent(b.assetCode)}/${encodeURIComponent(b.assetIssuer || "native")}`}
                className="flex items-center justify-between bg-stellar-card border border-stellar-border rounded-xl px-5 py-4 hover:border-stellar-link/50 transition-colors"
              >
                <div className="flex items-center gap-4">
                  <TokenIcon code={b.assetCode} image={b.token?.tomlImage} size={36} />
                  <div>
                    <p className="font-medium text-stellar-text">{b.assetCode}</p>
                    <p className="text-xs text-stellar-muted">
                      {b.token?.tomlName || b.token?.domain || (b.assetType === "native" ? t("dashboard.stellarLumens") : b.assetIssuer?.slice(0, 12) + "...")}
                    </p>
                  </div>
                </div>
                <p className="font-medium tabular-nums text-stellar-text">
                  {parseFloat(b.balance).toLocaleString(undefined, { maximumFractionDigits: 7 })}
                </p>
              </Link>
            ))}
          </div>
        </BalanceState>
      </div>
    </div>
  );
}