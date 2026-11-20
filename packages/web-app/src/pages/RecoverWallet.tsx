import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle, Loader2, ShieldAlert } from "lucide-react";
import { keyRecoveryApi, type RecoveryStatus } from "../lib/api";
import { useWalletStore } from "../store/wallet";
import { passphraseProblem } from "../lib/passphrase";

/**
 * Recover the wallet after forgetting its passphrase (managed wallets only).
 * Steps: email a code -> password + code start a wait (48 hours on mainnet) while the owner is warned
 * by email and sending is paused -> after the wait, a new passphrase is chosen and Amma releases the
 * recovery phrase once, which is used on the spot to set that passphrase on this device.
 */
const WAIT_TEXT = "48 hours";
const input = "w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue";
const primary = "w-full py-3 rounded-lg bg-stellar-blue text-white font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50";

type Step = "loading" | "off" | "intro" | "code" | "waiting" | "ready" | "done" | "rescue";

export default function RecoverWalletPage() {
  const resetPassphrase = useWalletStore((s) => s.resetPassphraseFromPhrase);
  const [step, setStep] = useState<Step>("loading");
  const [readyAt, setReadyAt] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [rescuePhrase, setRescuePhrase] = useState("");
  const [serverSynced, setServerSynced] = useState(true);

  const apply = useCallback((s: RecoveryStatus) => {
    setReadyAt(s.readyAt);
    setStep(!s.enabled ? "off" : s.state === "waiting" ? "waiting" : s.state === "ready" ? "ready" : "intro");
  }, []);
  useEffect(() => {
    let live = true;
    keyRecoveryApi.status().then((s) => live && apply(s)).catch(() => live && (setStep("off")));
    return () => { live = false; };
  }, [apply]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (e) { setError(e instanceof Error && e.message ? e.message : "Something went wrong. Try again."); } finally { setBusy(false); }
  }

  const sendCode = () => run(async () => { await keyRecoveryApi.sendCode(); setStep("code"); toast.success("We emailed you a 6 digit code."); });
  const start = () => run(async () => {
    const res = await keyRecoveryApi.start(password, code.trim());
    setReadyAt(res.readyAt); setPassword(""); setCode(""); setStep("waiting");
  });
  const cancel = () => run(async () => { await keyRecoveryApi.cancel(); setStep("intro"); toast.success("Recovery cancelled."); });
  const finish = () => run(async () => {
    // Check the new passphrase first: the recovery phrase is released only once.
    const weak = passphraseProblem(next);
    if (weak) throw new Error(weak);
    if (next !== again) throw new Error("The two passphrases do not match.");
    const { phrase } = await keyRecoveryApi.complete(password);
    setPassword("");
    try {
      const res = await resetPassphrase(phrase, next);
      setServerSynced(res.serverSynced);
      setStep("done");
    } catch {
      // The phrase can be released only once, so do not lose it: show it so it can be written down.
      setRescuePhrase(phrase);
      setStep("rescue");
    }
    setNext(""); setAgain("");
  });

  const when = readyAt ? new Date(readyAt).toLocaleString() : "";

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md bg-stellar-card rounded-2xl p-8 border border-stellar-border space-y-4">
        <h1 className="text-2xl font-bold text-stellar-text text-center">Recover my wallet</h1>

        {step === "loading" && <div className="flex justify-center"><Loader2 className="w-8 h-8 text-stellar-link animate-spin" /></div>}

        {step === "off" && <p className="text-stellar-muted">Wallet recovery is not available for this account.</p>}

        {step === "intro" && (
          <>
            <p className="text-stellar-text">Forgot your wallet passphrase? Amma can give you back your recovery phrase so you can choose a new one.</p>
            <p className="text-stellar-muted text-sm">To keep your money safe there is a wait of {WAIT_TEXT}. We email you when it starts, and you can cancel any time before it ends. Sending from the wallet is paused while you wait.</p>
            <button type="button" disabled={busy} onClick={sendCode} className={primary}>Email me a code</button>
          </>
        )}

        {step === "code" && (
          <form onSubmit={(e) => { e.preventDefault(); void start(); }} className="space-y-3">
            <p className="text-stellar-muted text-sm">Enter your account password and the 6 digit code we emailed you.</p>
            <input type="password" aria-label="Account password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Account password" className={input} />
            <input inputMode="numeric" maxLength={6} aria-label="6 digit code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 digit code" className={input} />
            <button type="submit" disabled={busy || !password || code.trim().length !== 6} className={primary}>Start recovery</button>
          </form>
        )}

        {step === "waiting" && (
          <>
            <div className="flex items-start gap-3 text-amber-200 text-sm"><ShieldAlert size={20} className="shrink-0" /><p>Recovery is waiting. It can finish after <strong>{when}</strong>. Sending from the wallet is paused until then.</p></div>
            <p className="text-stellar-muted text-sm">If you did not ask for this, cancel it now and change your account password.</p>
            <button type="button" disabled={busy} onClick={cancel} className="w-full py-3 rounded-lg border border-stellar-border text-stellar-text hover:bg-stellar-dark disabled:opacity-50">Cancel recovery</button>
          </>
        )}

        {step === "ready" && (
          <form onSubmit={(e) => { e.preventDefault(); void finish(); }} className="space-y-3">
            <p className="text-stellar-text">The wait is over. Choose a new wallet passphrase, then confirm with your account password.</p>
            <input type="password" aria-label="New wallet passphrase" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New wallet passphrase (12+ characters)" className={input} />
            <input type="password" aria-label="Repeat new wallet passphrase" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Repeat new passphrase" className={input} />
            <input type="password" aria-label="Account password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Account password" className={input} />
            <button type="submit" disabled={busy || !password || !next} className={primary}>Finish recovery</button>
            <button type="button" disabled={busy} onClick={cancel} className="w-full text-sm underline text-stellar-muted">Cancel recovery instead</button>
          </form>
        )}

        {step === "done" && (
          <div className="flex flex-col items-center gap-3 text-center">
            <CheckCircle className="w-14 h-14 text-green-500" />
            <p className="text-stellar-text">Your wallet is recovered. Use your new passphrase from now on.</p>
            {!serverSynced && <p className="text-amber-200 text-sm">Amma could not refresh its own backup copy of your key yet. Sending from this device works. To refresh it, switch the key backup off and on again in Settings.</p>}
            <Link to="/dashboard" className="px-6 py-3 rounded-xl bg-stellar-blue text-white font-semibold">Go to dashboard</Link>
          </div>
        )}

        {step === "rescue" && (
          <div className="space-y-3">
            <p className="text-amber-200 text-sm">This browser could not save your new passphrase. Your recovery phrase is shown once below. Write it down and keep it safe, then import it from the sign-in screen.</p>
            <p className="font-mono text-sm break-words text-stellar-text bg-stellar-dark rounded-lg p-3 select-all">{rescuePhrase}</p>
          </div>
        )}

        {error && <p role="alert" className="text-sm text-stellar-danger-text">{error}</p>}
        {step !== "loading" && step !== "done" && <p className="text-center"><Link to="/settings" className="text-sm text-stellar-muted underline">Back to settings</Link></p>}
      </div>
    </main>
  );
}
