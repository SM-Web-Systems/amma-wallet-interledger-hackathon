import { useEffect, useMemo, useState } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import { AlertCircle, Award, Loader2, Lock } from "lucide-react";
import { useWalletStore } from "../store/wallet";
import { decryptSecret } from "../lib/crypto";
import { listCustodyWallets, signLmsClaimWithAmma } from "../lib/custody-wallets";
import { loadStellarSecret } from "../lib/stellar-keystore";
import { allowedReturn, parseLmsClaim, signLmsClaim, claimNetworkCheck, stroopsToXlm, type LmsClaim } from "../lib/lmsClaim";

/**
 * The LMS sends a reward-claim challenge here in the URL fragment (never to a server):
 *   /lms/claim#message=<base64url text>&return=<LMS https URL>
 * The person reviews it, unlocks their wallet on this device and approves; the signature goes back
 * to the LMS in the fragment. Nothing is sent to the Stellar network.
 */
function readFragment() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const b64 = (params.get("message") ?? "").replace(/-/g, "+").replace(/_/g, "/");
  let message = "";
  try { message = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); } catch { /* invalid */ }
  return { message, ret: params.get("return") ?? "" };
}

/** The claim id on the challenge's second line, if well formed, so an expired claim can still be named on the way back. */
function claimIdOf(message: string): string | undefined {
  return /^claim:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(message.split("\n")[1] ?? "")?.[1];
}

/** Why the "Back to the LMS" link is offered. These three values are the only `error=` values the page ever sends, and never with a signature or password. */
type BackReason = "expired" | "unavailable" | "invalid";
/** What went wrong. With `back`, the page also offers the "Back to the LMS" link carrying that reason. */
type Failure = { text: string; back?: BackReason };

const EXPIRED: Failure = { text: "This claim expired. Go back to the LMS and start a new one.", back: "expired" };
const UNAVAILABLE: Failure = { text: "Amma can't approve this claim right now. Go back to the LMS and try again later.", back: "unavailable" };

/** The claim has run out (server or device check, or the clock): nothing on this page can approve it any more. */
function claimIsDead(e: unknown, claim: LmsClaim): boolean {
  const text = e instanceof Error ? e.message : "";
  // `claim_expired` is the server's code for a well-formed claim whose time has run out.
  if ((e as { code?: unknown } | null)?.code === "claim_expired") return true;
  return text === "This is not a valid LMS reward claim." || text.startsWith("This claim has expired") || claim.expiresAt.getTime() <= Date.now();
}

/** Plain-English text for a failed Amma-password approval. The server's own sentences are mostly plain; a bare status code gets one too. */
function ammaFailure(e: unknown, claim: LmsClaim): Failure {
  const text = e instanceof Error ? e.message : "";
  if (claimIsDead(e, claim)) return EXPIRED;
  if (text === "Approving with your Amma password is not switched on here yet.") return UNAVAILABLE;
  // The route limit (10 a minute) answers with the global rate-limit body.
  if (text === "Too many requests. Please slow down.") return { text: "Too many tries in a minute. Wait a minute, then try again." };
  const status = /^API error (\d+)$/.exec(text)?.[1];
  switch (status) {
    case "403": return { text: "That password is not correct." };
    case "429": return { text: "Too many tries in a minute. Wait a minute, then try again." };
    case "423": return { text: "This account is frozen while a recovery request is waiting." };
    case "503": return UNAVAILABLE;
    case undefined: return { text: text || "The claim could not be approved. Try again." };
    default: return { text: "The claim could not be approved. Try again." };
  }
}

/** "4:05 left" for the time remaining, never negative. */
function timeLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} left`;
}

export default function LmsClaimSign() {
  const accounts = useWalletStore((s) => s.accounts);
  const network = useWalletStore((s) => s.network);
  const [{ message, ret }] = useState(readFragment);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [note, setNote] = useState("");
  // The claim and the return address are checked apart, so a dead claim still has a checked way back to the LMS.
  // A return address that is not allowed hides the form (a signature must never go there) and the link.
  const parsed = useMemo(() => {
    let claim: LmsClaim | null = null, back: URL | null = null, problem = "";
    try { claim = parseLmsClaim(message); } catch (e) { problem = (e as Error).message; }
    try { back = allowedReturn(ret); } catch (e) { problem ||= (e as Error).message; claim = null; }
    return { claim, back, problem };
  }, [message, ret]);

  // Time left on the claim, ticking once a second while the page is open.
  const expiresAt = parsed.claim?.expiresAt.getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [expiresAt]);
  // `deadByServer`: the server or device check said the claim can no longer be approved, whatever the clock here says.
  const [deadByServer, setDeadByServer] = useState(false);
  const expired = deadByServer || (expiresAt !== undefined && now >= expiresAt);
  // The network label comes from the wallet store (the app's configured Stellar network: VITE_DEFAULT_NETWORK, default public).
  // A signed `network:` line, once the LMS sends one, is cross-checked against it.
  const net = parsed.claim ? claimNetworkCheck(network, parsed.claim.network) : null;
  // Do not keep a typed password around once the claim can no longer be approved.
  useEffect(() => { if (expired) setPassphrase(""); }, [expired]);

  // Which kind of wallet the destination is: "checking" until the Amma-held list answers; any failure means the device path.
  const destination = parsed.claim?.destination;
  const [kind, setKind] = useState<"checking" | "amma" | "device">(destination ? "checking" : "device");
  useEffect(() => {
    if (!destination) return;
    let live = true;
    listCustodyWallets()
      .then((wallets) => { if (live) setKind(wallets.some((w) => w.chain === "stellar" && w.address === destination) ? "amma" : "device"); })
      .catch(() => { if (live) setKind("device"); });
    return () => { live = false; };
  }, [destination]);

  function goBack(fields: Record<string, string>) {
    if (!parsed.back) return;
    const url = new URL(parsed.back.toString());
    url.hash = new URLSearchParams(fields).toString();
    window.location.assign(url.toString());
  }

  async function approve(event: React.FormEvent) {
    event.preventDefault();
    const claim = parsed.claim;
    // Read the clock directly: `expired` is state and can lag a second behind, and no password may be sent for a dead claim.
    if (!claim || busy || kind === "checking" || expired || net?.mismatch || claim.expiresAt.getTime() <= Date.now()) return;
    setBusy(true); setError(null);
    if (kind === "amma") {
      const password = passphrase;
      setPassphrase("");
      try {
        const signature = await signLmsClaimWithAmma(message, password);
        goBack({ claim: claim.claimId, signature });
      } catch (e) {
        const text = e instanceof Error ? e.message : "";
        // Amma cannot sign for this wallet (not held, or the account keeps its own keys): offer the device passphrase instead of leaving the person stuck.
        if (/Amma-held wallet|Use your wallet passphrase/.test(text)) {
          setKind("device");
          setNote("Amma can't approve this claim for you, so use your wallet passphrase from this device.");
        } else {
          const failure = ammaFailure(e, claim);
          if (failure === EXPIRED) setDeadByServer(true);
          setError(failure);
        }
        setBusy(false);
      }
      return;
    }
    try {
      const signature = await signLmsClaim(message, accounts, passphrase, decryptSecret, (s) => Keypair.fromSecret(s), loadStellarSecret);
      setPassphrase("");
      goBack({ claim: claim.claimId, signature });
    } catch (e) {
      const text = (e as Error).message;
      if (claimIsDead(e, claim)) setDeadByServer(true);
      setError(claimIsDead(e, claim) ? EXPIRED : { text: text.includes("decrypt") ? "That passphrase did not unlock this wallet." : text });
      setBusy(false);
    }
  }

  // What to show above the form: a claim that cannot go on (expired, malformed, not allowed), with a way back when the LMS address is allowed.
  const problem: Failure | null = parsed.problem
    ? { text: parsed.problem.startsWith("This claim has expired") ? EXPIRED.text : parsed.problem, back: parsed.back ? (parsed.problem.startsWith("This claim has expired") ? "expired" : "invalid") : undefined }
    : expired ? { ...EXPIRED, back: parsed.back ? "expired" : undefined } : null;
  // Link to the checked LMS address, with only the reason (and the claim id when the text has a well-formed one) in the fragment, as goBack does.
  const backLinkFor = (reason: BackReason) => {
    if (!parsed.back) return null;
    const u = new URL(parsed.back.toString());
    const claimId = reason === "invalid" ? undefined : (parsed.claim?.claimId ?? claimIdOf(message));
    u.hash = new URLSearchParams(claimId ? { claim: claimId, error: reason } : { error: reason }).toString();
    return <a href={u.toString()} className="ui-btn-secondary block w-full text-center">Back to the LMS</a>;
  };
  const mismatchText = net?.mismatch ? `This claim is for ${net.signedLabel}, but this wallet is on ${net.label}. Do not approve it. Go back to the LMS and start a new claim.` : "";
  const reason = net?.mismatch ? `Approve is off: this claim is for ${net.signedLabel} and this wallet is on ${net.label}.` : !passphrase && kind !== "checking" ? (kind === "amma" ? "Enter your Amma password to approve." : "Enter your wallet passphrase to approve.") : "";

  return <div className="flex min-h-screen items-start justify-center px-4 py-8 text-stellar-text sm:items-center">
    <main className="w-full max-w-md space-y-5">
      <div className="text-center">
        <img src="/favicon-128.png" alt="Amma Wallet" className="mx-auto mb-4 h-14 w-14 rounded-2xl" />
        <h1 className="text-2xl font-bold">Approve LMS reward claim</h1>
        <p className="mt-1 text-stellar-muted">This proves you still control this wallet. No money moves until the LMS pays it.</p>
      </div>
      {problem && <div className="space-y-3">
        <div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm"><AlertCircle size={18} className="mt-0.5 shrink-0 text-red-500" aria-hidden /><p>{problem.text}</p></div>
        {problem.back && backLinkFor(problem.back)}
      </div>}
      {parsed.claim && !expired && <form onSubmit={approve} className="ui-card space-y-4 p-5" aria-label="Reward claim">
        <div className="flex items-center gap-3"><Award className="text-stellar-purple" aria-hidden /><p data-testid="claim-amount" className="text-lg font-semibold">{stroopsToXlm(parsed.claim.amountStroops)} XLM</p>{net && <span data-testid="claim-network" className="rounded-full border border-stellar-border px-2 py-0.5 text-xs font-medium text-stellar-muted">{net.label}</span>}</div>
        {net?.mismatch && <p role="alert" className="text-sm text-red-500">{mismatchText}</p>}
        <dl className="space-y-2 text-sm">
          <div><dt className="text-stellar-muted">To your Stellar wallet</dt><dd className="break-all font-mono">{parsed.claim.destination}</dd></div>
          <div><dt className="text-stellar-muted">Requested by</dt><dd>{parsed.back?.protocol === "lmsmobile:" ? "LMS mobile app" : parsed.back?.host}</dd></div>
          <div><dt className="text-stellar-muted">Expires</dt><dd>{parsed.claim.expiresAt.toLocaleString()} <span data-testid="claim-countdown" className="font-medium">({timeLeft(parsed.claim.expiresAt.getTime() - now)})</span></dd></div>
        </dl>
        {kind === "amma"
          ? <div>
            <label className="block text-sm font-medium">Your Amma password
              <input type="password" name="password" autoComplete="current-password" required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="ui-field mt-1 w-full" />
            </label>
            <p className="mt-1 text-xs text-stellar-muted">The password you use to sign in to Amma.</p>
          </div>
          : <div>
            <label className="block text-sm font-medium">Wallet passphrase
              <input type="password" autoComplete="off" required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={kind === "checking"} className="ui-field mt-1 w-full" />
            </label>
            <p className="mt-1 text-xs text-stellar-muted">This wallet is kept only on this device. Use its wallet passphrase, not your Amma password.</p>
          </div>}
        {note && <p role="status" className="text-sm text-stellar-muted">{note}</p>}
        {error && <p role="alert" className="text-sm text-red-500">{error.text}</p>}
        {error?.back && backLinkFor(error.back)}
        <div className="flex gap-3">
          <button type="button" className="ui-btn-secondary flex-1" disabled={busy} onClick={() => goBack({ claim: parsed.claim!.claimId, declined: "1" })}>Decline</button>
          <button type="submit" className="ui-btn-primary flex flex-1 items-center justify-center gap-2" disabled={busy || kind === "checking" || !passphrase || expired || !!net?.mismatch} aria-describedby={reason ? "approve-reason" : undefined}>
            {busy || kind === "checking" ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Lock size={16} aria-hidden />}{kind === "checking" ? "Checking your wallet…" : "Approve"}
          </button>
        </div>
        {reason && <p id="approve-reason" className="text-xs text-stellar-muted">{reason}</p>}
      </form>}
    </main>
  </div>;
}
