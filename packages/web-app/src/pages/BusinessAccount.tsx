/**
 * Self-serve business page (/business), testnet only, behind BUSINESS_PAGE=on on the API.
 *
 * A business enters its own Amma API key (funding:read). The key is held in this page's memory only: it is never written to
 * storage, the URL or logs, and it is forgotten on sign out or when the tab closes. The page shows the business's credits,
 * how to deposit (its own wallet address, no memo, and the exact amount for each bundle), its deposits (credited or held),
 * fees and bundle purchases.
 */
import { useState } from "react";
import { Building2, Copy, Check, Loader2, LogOut } from "lucide-react";
import { API_BASE } from "../lib/constants";

type Plan = "monthly" | "annual";
interface Overview {
  network: string;
  depositAddress: string | null;
  memo: null;
  firstDeposit: boolean;
  accountActive: boolean;
  credits: { annualCredits: number; monthlyCredits: number; fundingXlm: string; managementXlm: string; registrationFeeWaived: boolean };
  bundles: { slug: string; name: string; plan: Plan; users: number; sendXlm: string }[];
  deposits: { id: number; receivedAt: string; amountXlm: string; state: "credited" | "held" | "resolved"; heldReason: string | null; bundleSlug: string | null; plan: Plan | null; users: number | null; feeDueXlm: string; txHash: string }[];
  fees: { onDepositsXlm: string; managementXlm: string; chargedXlm: string; paidXlm: string; pendingXlm: string; failedXlm: string };
  purchases: { id: number; purchasedAt: string; bundleSlug: string; bundleName: string; amountXlm: string; users: number | null }[];
}

const HELD_REASON: Record<string, string> = {
  no_bundle_matches_amount: "Held: the amount does not match a bundle. We will be in touch.",
  amount_matches_more_than_one_bundle: "Held: the amount matches more than one bundle. We will be in touch.",
  no_catalog: "Held: no bundles were on offer. We will be in touch.",
};
const when = (iso: string) => new Date(iso).toLocaleString();
const txLink = (network: string, hash: string) => `https://stellar.expert/explorer/${network === "public" ? "public" : "testnet"}/tx/${hash}`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = `biz-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="rounded-xl border border-stellar-border bg-stellar-dark p-4 space-y-3">
      <h2 id={id} className="text-base font-semibold text-stellar-text">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-stellar-muted">{label}</dt>
      <dd className="font-mono text-sm text-stellar-text">{value}</dd>
    </div>
  );
}

export default function BusinessAccount() {
  const [keyInput, setKeyInput] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!keyInput.trim()) { setError("Enter your business API key."); return; }
    setLoading(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/tenant/business/overview`, { headers: { "x-api-key": keyInput.trim() }, cache: "no-store" });
      if (res.status === 404) { setData(null); setError("The business page is not available here yet."); return; }
      if (res.status === 401 || res.status === 403) { setData(null); setError("That key was not accepted. Use your business API key with the funding:read permission."); return; }
      if (!res.ok) { setData(null); setError("Something went wrong. Please try again shortly."); return; }
      setData((await res.json()) as Overview);
    } catch {
      setData(null); setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const signOut = () => { setData(null); setKeyInput(""); setError(null); };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* copy not allowed */ }
  };

  return (
    <main className="min-h-screen bg-stellar-bg px-4 py-8">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Building2 className="h-7 w-7 text-stellar-blue" aria-hidden />
            <div>
              <h1 className="text-xl font-bold text-stellar-text">Business account</h1>
              <p className="text-xs text-stellar-muted">Test network only. No real money.</p>
            </div>
          </div>
          {data && (
            <button type="button" onClick={signOut} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-stellar-border px-3 text-sm text-stellar-text">
              <LogOut className="h-4 w-4" aria-hidden /> Sign out
            </button>
          )}
        </header>

        {!data && (
          <form onSubmit={load} className="rounded-xl border border-stellar-border bg-stellar-dark p-4 space-y-3">
            <label htmlFor="biz-key" className="block text-sm font-medium text-stellar-text">Business API key</label>
            <input
              id="biz-key" type="password" autoComplete="off" spellCheck={false} value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className="w-full rounded-lg border border-stellar-border bg-stellar-bg px-3 py-2.5 font-mono text-sm text-stellar-text"
            />
            <p className="text-xs text-stellar-muted">Kept on this page only, never saved. It is forgotten when you sign out or close the tab.</p>
            <button type="submit" disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-stellar-blue px-4 text-sm font-medium text-white disabled:opacity-60">
              {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Show my account
            </button>
          </form>
        )}

        {error && <div role="alert" className="rounded-lg border border-stellar-danger bg-stellar-card p-3 text-sm text-stellar-text">{error}</div>}

        {data && (
          <>
            <Section title="Credits">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Annual credits" value={data.credits.annualCredits} />
                <Stat label="Monthly credits" value={data.credits.monthlyCredits} />
                <Stat label="Funding pot (XLM)" value={data.credits.fundingXlm} />
                <Stat label="Management pot (XLM)" value={data.credits.managementXlm} />
              </dl>
            </Section>

            <Section title="How to deposit">
              {!data.accountActive ? (
                <p className="text-sm text-stellar-text">Your account is suspended, so deposits are paused. Please contact Amma before sending anything.</p>
              ) : data.depositAddress ? (
                <>
                  <p className="text-sm text-stellar-text">Send XLM to your business wallet:</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-lg bg-stellar-bg p-2 text-xs text-stellar-text">{data.depositAddress}</code>
                    <button type="button" onClick={() => copy(data.depositAddress!)} aria-label="Copy deposit address" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-stellar-border text-stellar-text">
                      {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                    </button>
                  </div>
                  <p className="text-sm text-stellar-text">No memo needed: this address is yours alone.</p>
                  {data.firstDeposit && (
                    <p className="text-sm text-stellar-text">
                      This is your first deposit, so the amounts include the 1 XLM account reserve{data.credits.registrationFeeWaived ? "" : " and the 100 XLM registration fee"}.
                      {" "}Wait until it shows as credited below before you send another payment.
                    </p>
                  )}
                  <table className="w-full text-left text-sm">
                    <thead><tr className="text-xs text-stellar-muted"><th className="py-1">Bundle</th><th className="py-1">Users</th><th className="py-1 text-right">Send exactly (XLM)</th></tr></thead>
                    <tbody>
                      {data.bundles.map((b) => (
                        <tr key={b.slug} className="border-t border-stellar-border text-stellar-text">
                          <td className="py-1.5">{b.name}</td><td className="py-1.5">{b.users}</td><td className="py-1.5 text-right font-mono">{b.sendXlm}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-xs text-stellar-muted">Send one bundle's exact amount per payment. Any other amount is held until we review it.</p>
                </>
              ) : (
                <p className="text-sm text-stellar-text">Your deposit wallet is not set up yet. Please contact Amma.</p>
              )}
            </Section>

            <Section title="Deposits">
              {data.deposits.length === 0 ? <p className="text-sm text-stellar-muted">No deposits yet.</p> : (
                <ul className="divide-y divide-stellar-border">
                  {data.deposits.map((d) => (
                    <li key={d.id} className="py-2 text-sm text-stellar-text">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-mono">{d.amountXlm} XLM</span>
                        <span className={d.state === "credited" ? "text-stellar-success" : "text-amber-300"}>
                          {d.state === "credited" ? `Credited: ${d.bundleSlug}` : d.state === "held" ? "Held" : "Resolved"}
                        </span>
                      </div>
                      <div className="text-xs text-stellar-muted">
                        {when(d.receivedAt)} · <a className="underline" href={txLink(data.network, d.txHash)} target="_blank" rel="noreferrer">transaction</a>
                        {d.state === "credited" && ` · fee ${d.feeDueXlm} XLM`}
                      </div>
                      {d.state === "held" && <p className="text-xs text-stellar-muted">{(d.heldReason && HELD_REASON[d.heldReason]) ?? "Held for review. We will be in touch."}</p>}
                      {d.state === "resolved" && <p className="text-xs text-stellar-muted">Reviewed and settled by Amma.</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Fees">
              <p className="text-xs text-stellar-muted">Fees Amma charges, and how far their transfer from your wallet has got.</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="On deposits (XLM)" value={data.fees.onDepositsXlm} />
                <Stat label="Monthly management (XLM)" value={data.fees.managementXlm} />
                <Stat label="Fees charged (XLM)" value={data.fees.chargedXlm} />
                <Stat label="Transferred (XLM)" value={data.fees.paidXlm} />
                <Stat label="In progress (XLM)" value={data.fees.pendingXlm} />
                <Stat label="Failed, to retry (XLM)" value={data.fees.failedXlm} />
              </dl>
            </Section>

            <Section title="Bundle purchases">
              {data.purchases.length === 0 ? <p className="text-sm text-stellar-muted">No purchases yet.</p> : (
                <ul className="divide-y divide-stellar-border">
                  {data.purchases.map((p) => (
                    <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm text-stellar-text">
                      <span>{p.bundleName}{p.users ? ` (${p.users} users)` : ""}</span>
                      <span className="font-mono">{p.amountXlm} XLM</span>
                      <span className="w-full text-xs text-stellar-muted">{when(p.purchasedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </main>
  );
}
