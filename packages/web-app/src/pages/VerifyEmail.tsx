import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";

const API_BASE = import.meta.env.VITE_API_URL || "";

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"loading" | "confirm" | "declined" | "success" | "error">("loading");
  const [message, setMessage] = useState("");
  const [link, setLink] = useState<{email: string; phoneHint: string | null} | null>(null);
  const token = searchParams.get("token");

  function showResult(data: {success?: boolean; message?: string; error?: string}) {
    if (data.success) {
      setStatus("success");
      setMessage(data.message || "Email verified successfully!");
    } else {
      setStatus("error");
      setMessage(data.error || "Verification failed.");
    }
  }
  function showNetworkError() {
    setStatus("error");
    setMessage("Network error. Please try again.");
  }

  // Opening the page only reads the link. Mail scanners and the wrong person change nothing.
  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("No verification token provided.");
      return;
    }

    fetch(`${API_BASE}/api/v1/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.requiresConfirmation) {
          setLink({email: data.email, phoneHint: data.phoneHint ?? null});
          setStatus("confirm");
        } else {
          showResult(data);
        }
      })
      .catch(showNetworkError);
  }, [token]);

  function confirm() {
    setStatus("loading");
    fetch(`${API_BASE}/api/v1/auth/verify-email`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({token}),
    })
      .then((res) => res.json())
      .then(showResult)
      .catch(showNetworkError);
  }

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md bg-stellar-card rounded-2xl p-8 border border-stellar-border text-center">
        <h1 className="text-2xl font-bold text-stellar-text mb-6">Email Verification</h1>

        {status === "loading" && (
          <div className="flex flex-col items-center gap-4">
            <Loader2 className="w-12 h-12 text-stellar-link animate-spin" />
            <p className="text-stellar-muted">Verifying your email...</p>
          </div>
        )}

        {status === "confirm" && link && (
          <div className="flex flex-col items-center gap-4">
            <p className="text-stellar-text">Add this email to an AmmaWallet account?</p>
            <p className="text-stellar-text font-semibold break-all">{link.email}</p>
            {link.phoneHint && <p className="text-stellar-muted text-sm">The account uses a phone number ending in {link.phoneHint}.</p>}
            <p className="text-amber-200 text-sm">Only continue if you asked for this. If you did not, someone else may be trying to link your email to their account.</p>
            <button type="button" onClick={confirm} className="mt-2 px-6 py-3 rounded-xl bg-stellar-blue hover:bg-stellar-purple text-white font-semibold">Yes, add it to my account</button>
            <button type="button" onClick={() => setStatus("declined")} className="text-sm underline text-stellar-muted">I did not ask for this</button>
          </div>
        )}

        {status === "declined" && (
          <p className="text-stellar-text">Nothing was changed. You can close this page.</p>
        )}

        {status === "success" && (
          <div className="flex flex-col items-center gap-4">
            <CheckCircle className="w-16 h-16 text-green-500" />
            <p className="text-stellar-text text-lg">{message}</p>
            <button
              onClick={() => navigate("/dashboard")}
              className="mt-4 px-6 py-3 rounded-xl bg-stellar-blue hover:bg-stellar-purple text-white font-semibold hover:opacity-90 transition"
            >
              Go to Dashboard
            </button>
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center gap-4">
            <XCircle className="w-16 h-16 text-red-500" />
            <p className="text-red-700 dark:text-red-400 text-lg">{message}</p>
            <button
              onClick={() => navigate("/login")}
              className="mt-4 px-6 py-3 rounded-xl bg-stellar-dark border border-stellar-border text-stellar-text hover:bg-stellar-border transition"
            >
              Back to Login
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
