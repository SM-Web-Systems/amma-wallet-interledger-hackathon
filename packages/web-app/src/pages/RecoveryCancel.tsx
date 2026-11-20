import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle, Loader2 } from "lucide-react";
import { keyRecoveryApi } from "../lib/api";

/**
 * The page behind the "Cancel recovery" link in the alert email. No sign-in needed: the owner may be
 * locked out, or on another device. Opening the page changes nothing; only the button cancels.
 */
export default function RecoveryCancelPage() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [status, setStatus] = useState<"ask" | "working" | "done" | "error">(token ? "ask" : "error");
  const [message, setMessage] = useState(token ? "" : "This link is not valid.");

  async function cancel() {
    if (!token) return;
    setStatus("working");
    try {
      await keyRecoveryApi.cancelByToken(token);
      setStatus("done");
    } catch (e) {
      setMessage(e instanceof Error && e.message ? e.message : "Could not cancel. Try again.");
      setStatus("error");
    }
  }

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md bg-stellar-card rounded-2xl p-8 border border-stellar-border text-center space-y-4">
        <h1 className="text-2xl font-bold text-stellar-text">Cancel wallet recovery</h1>
        {status === "ask" && (
          <>
            <p className="text-stellar-text">Someone asked to recover your wallet's keys. Cancel it if this was not you.</p>
            <button type="button" onClick={cancel} className="px-6 py-3 rounded-xl bg-red-600 text-white font-semibold">Yes, cancel the recovery</button>
            <p className="text-stellar-muted text-sm">If this was you, close this page and wait for the recovery to finish.</p>
          </>
        )}
        {status === "working" && <Loader2 className="w-10 h-10 mx-auto text-stellar-link animate-spin" />}
        {status === "done" && (
          <>
            <CheckCircle className="w-14 h-14 mx-auto text-green-500" />
            <p className="text-stellar-text">The recovery was cancelled and sending is available again.</p>
            <p className="text-amber-200 text-sm">If you did not ask for it, someone may know your password. Change your account password now.</p>
            <Link to="/forgot-password" className="inline-block text-stellar-link underline">Reset my password</Link>
          </>
        )}
        {status === "error" && <p className="text-stellar-danger-text">{message}</p>}
      </div>
    </main>
  );
}
