import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getAccessToken } from "../lib/api";
import { API_BASE } from "../lib/constants";
import { Shield, CheckCircle, Loader2, AlertCircle } from "lucide-react";

import { savePendingOAuth, consumePendingOAuth } from "../lib/pending-oauth";

interface ConsentInfo {
  client_name: string;
  client_id: string;
  scopes: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
}

// Plain words for the error page. Raw codes and server descriptions are never shown.
const PLAIN_ERRORS: Record<string, string> = {
  invalid_client: "This app is not registered with Amma.",
  invalid_request: "This sign-in link is not valid. Go back to the app and try again.",
  invalid_scope: "This app asked for access that Amma does not allow.",
};
const GENERIC_ERROR = "Something went wrong while connecting this app. Try again from the app.";
const NETWORK_ERROR = "Amma could not be reached. Check your connection and try again.";
function plainError(status: number, code: unknown): string {
  if (status === 401) return "Your Amma session has ended. Sign in again, then retry from the app.";
  return (typeof code === "string" && PLAIN_ERRORS[code]) || GENERIC_ERROR;
}

export default function OAuthConsent() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [status, setStatus] = useState<"loading" | "consent" | "approving" | "error">("loading");
  const [consent, setConsent] = useState<ConsentInfo | null>(null);
  const [error, setError] = useState("");

  const callAuthorize = useCallback(async () => {
    const token = getAccessToken();
    if (!token) {
      // Not logged in — save OAuth params and redirect to login
      savePendingOAuth(window.location.search);
      navigate("/login", { replace: true });
      return;
    }
    // Signed in and handling the request now: a saved copy must not resurface on a later sign-in.
    consumePendingOAuth();

    try {
      const qs = searchParams.toString();
      const res = await fetch(`${API_BASE}/api/v1/oauth/authorize?${qs}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(plainError(res.status, body.error));
        setStatus("error");
        return;
      }

      const data = await res.json();

      if (data.action === "consent_required") {
        setConsent(data as ConsentInfo);
        setStatus("consent");
      } else if (data.redirect_url) {
        // Already consented — redirect to RP callback
        window.location.href = data.redirect_url;
      } else {
        setError(GENERIC_ERROR);
        setStatus("error");
      }
    } catch {
      setError(NETWORK_ERROR);
      setStatus("error");
    }
  }, [searchParams, navigate]);

  useEffect(() => {
    callAuthorize();
  }, [callAuthorize]);

  const handleApprove = async () => {
    if (!consent) return;
    setStatus("approving");

    const token = getAccessToken();
    if (!token) {
      savePendingOAuth(window.location.search);
      navigate("/login", { replace: true });
      return;
    }

    try {
      // 1. Grant consent
      const consentRes = await fetch(`${API_BASE}/api/v1/oauth/consent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          client_id: consent.client_id,
          scopes: consent.scopes,
        }),
      });

      if (!consentRes.ok) {
        const body = await consentRes.json().catch(() => ({}));
        setError(plainError(consentRes.status, body.error));
        setStatus("error");
        return;
      }

      // 2. Re-call authorize (now with consent granted)
      const qs = searchParams.toString();
      const authRes = await fetch(`${API_BASE}/api/v1/oauth/authorize?${qs}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!authRes.ok) {
        const body = await authRes.json().catch(() => ({}));
        setError(plainError(authRes.status, body.error));
        setStatus("error");
        return;
      }

      const data = await authRes.json();
      if (data.redirect_url) {
        window.location.href = data.redirect_url;
      } else {
        setError(GENERIC_ERROR);
        setStatus("error");
      }
    } catch {
      setError(NETWORK_ERROR);
      setStatus("error");
    }
  };

  const handleDeny = () => {
    // Use only what the server validated in /authorize (consent), never the page query string.
    if (!consent) {
      navigate("/dashboard", { replace: true });
      return;
    }
    const url = new URL(consent.redirect_uri);
    url.searchParams.set("error", "access_denied");
    if (consent.state) url.searchParams.set("state", consent.state);
    window.location.assign(url.toString());
  };

  // Plain words for scopes Amma issues. An unknown scope is still listed, by its code, so none is hidden.
  const scopeLabel = (scope: string): string => {
    switch (scope) {
      case "openid": return t("oauthConsent.scope.openid", "Verify your identity");
      case "profile": return t("oauthConsent.scope.profile", "View your profile information");
      case "email": return t("oauthConsent.scope.email", "View your email address");
      default: return t("oauthConsent.scope.other", { defaultValue: "Other account access ({{scope}})", scope, interpolation: { escapeValue: false } });
    }
  };

  if (status === "loading" || status === "approving") {
    return (
      <main className="flex items-center justify-center min-h-screen p-6">
        <div className="text-center space-y-4">
          <Loader2 size={40} className="animate-spin text-purple-500 mx-auto" />
          <p className="text-stellar-muted">
            {status === "approving" ? "Authorizing..." : "Loading..."}
          </p>
        </div>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="flex items-center justify-center min-h-screen p-6">
        <div className="w-full max-w-md bg-stellar-card border border-stellar-border rounded-2xl p-6 text-center space-y-4">
          <AlertCircle size={40} className="text-red-500 mx-auto" />
          <h1 className="text-xl font-bold text-stellar-text">{t("oauthConsent.errorTitle", "This sign-in request did not work")}</h1>
          <p role="alert" className="text-stellar-muted">{error}</p>
          <button
            onClick={() => navigate("/dashboard", { replace: true })}
            className="px-4 py-2 bg-stellar-card border border-stellar-border rounded-lg text-stellar-text hover:bg-stellar-hover"
          >
            Return to Dashboard
          </button>
        </div>
      </main>
    );
  }

  // Consent screen
  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <img src="/favicon-128.png" alt="Amma Wallet" className="w-16 h-16 mx-auto mb-4 rounded-2xl" />
          <h1 className="text-2xl font-bold text-stellar-text">Authorize Access</h1>
        </div>

        <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-5">
          <div className="flex items-center gap-3">
            <Shield size={24} className="text-purple-500 flex-shrink-0" />
            <div>
              <p className="text-stellar-text font-medium">{consent?.client_name}</p>
              <p className="text-sm text-stellar-muted">wants to access your account</p>
            </div>
          </div>

          <div className="border-t border-stellar-border pt-4">
            <p className="text-sm font-medium text-stellar-text mb-3">This will allow the application to:</p>
            <ul className="space-y-2">
              {consent?.scopes.split(" ").map((scope) => (
                <li key={scope} className="flex items-center gap-2 text-sm text-stellar-muted">
                  <CheckCircle size={16} className="text-green-500 flex-shrink-0" />
                  {scopeLabel(scope)}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleDeny}
              className="flex-1 px-4 py-2.5 bg-stellar-card border border-stellar-border rounded-lg text-stellar-text hover:bg-stellar-hover font-medium"
            >
              Deny
            </button>
            <button
              onClick={handleApprove}
              className="flex-1 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium"
            >
              Approve
            </button>
          </div>
        </div>

        <p className="text-xs text-center text-stellar-muted">
          {t("oauthConsent.stopSharing", { defaultValue: "To stop sharing, contact {{name}} or Amma support.", name: consent?.client_name || t("oauthConsent.theApp", "the app"), interpolation: { escapeValue: false } })}
        </p>
      </div>
    </main>
  );
}
