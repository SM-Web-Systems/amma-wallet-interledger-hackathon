/**
 * SsoLogin — AmmaWallet login page used during an SSO redirect flow.
 *
 * Entry: /sso/login?callback=<url>&state=<state-jwt>
 *
 * Flow:
 *   1. User arrives here redirected from a relying party (e.g. LMS).
 *   2. If already authenticated, request assertion immediately.
 *   3. Otherwise show the standard login form.
 *   4. After successful login, call POST /api/v1/sso/token to get an assertion.
 *   5. Redirect the browser to callbackUrl?assertion=<token>&state=<state>.
 */

import { useState, useEffect, useRef } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { getAccessToken, restoreSession } from "../lib/api";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Eye, EyeOff, Mail, Lock, Loader2, ArrowRight } from "lucide-react";
import { Turnstile } from "../components/Turnstile";

export default function SsoLoginPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const callbackUrl = searchParams.get("callback") ?? "";
  const state       = searchParams.get("state") ?? "";

  const [email,        setEmail]        = useState("");
  const [password,     setPassword]     = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [challengeVersion, setChallengeVersion] = useState(0);
  const submitInFlight = useRef(false);
  const [twoFaRequired, setTwoFaRequired]   = useState(false);
  const [twoFaToken,    setTwoFaToken]      = useState("");
  const [twoFaMethod,   setTwoFaMethod]     = useState("");
  const [asserting, setAsserting] = useState(false);
  const [pageError, setPageError] = useState("");
  const assertionInFlight = useRef(false);

  const login          = useAuthStore((s) => s.login);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading      = useAuthStore((s) => s.isLoading);

  // Safe display of the relying-party origin (avoids showing raw callback URL)
  const rpOrigin = (() => {
    try { return new URL(callbackUrl).hostname; }
    catch { return callbackUrl; }
  })();

  // Request an assertion JWT from AmmaWallet then redirect to the RP callback.
  async function requestAssertion() {
    // Login and session hydration may settle together; one assertion is enough.
    if (assertionInFlight.current) return;
    assertionInFlight.current = true;
    setAsserting(true);
    const accessToken = getAccessToken() ?? (await restoreSession() ? getAccessToken() : null);
    if (!accessToken) {
      setPageError("No active session. Please sign in first.");
      setAsserting(false);
      assertionInFlight.current = false;
      return;
    }
    try {
      const res = await fetch("/api/v1/sso/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ callbackUrl, state }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `SSO token request failed (${res.status})`);
      }
      const { assertionToken } = await res.json() as { assertionToken: string };

      // Build the redirect URL (callback is already a full HTTPS URL)
      const redirect = new URL(callbackUrl);
      redirect.searchParams.set("assertion", assertionToken);
      redirect.searchParams.set("state", state);
      // Keep the guard set: the page stays alive briefly after this assignment,
      // and a second assertion would reuse the single-use state and be rejected.
      window.location.href = redirect.toString();
    } catch (err: any) {
      setPageError(err.message || "SSO failed. Please try again.");
      setAsserting(false);
      assertionInFlight.current = false;
    }
  }

  // Resume after profile/session hydration as well as an authenticated mount.
  useEffect(() => {
    if (isAuthenticated && callbackUrl && state) {
      requestAssertion();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, callbackUrl, state]);

  // ── Guard: missing required SSO params ──────────────────────────────────
  if (!callbackUrl || !state) {
    return (
      <main className="flex items-center justify-center min-h-screen p-6">
        <div className="text-center">
          <p className="text-red-700 dark:text-red-400 mb-4">Invalid SSO request — missing required parameters.</p>
          <Link to="/login" className="text-stellar-link hover:text-stellar-purple transition-colors">
            ← Back to login
          </Link>
        </div>
      </main>
    );
  }

  // ── Loading overlay while asserting / redirecting ────────────────────────
  if (asserting) {
    return (
      <main className="flex items-center justify-center min-h-screen p-6">
        <div className="text-center space-y-4">
          <Loader2 size={36} className="animate-spin text-stellar-link mx-auto" />
          <p className="text-stellar-text font-medium">Signing you in to {rpOrigin}…</p>
          <p className="text-stellar-muted text-sm">Redirecting, please wait.</p>
        </div>
      </main>
    );
  }

  // ── Login form ───────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlight.current) return;
    setPageError("");

    if (!email || !password) {
      toast.error(t("auth.fillAllFields"));
      return;
    }
    if (!turnstileToken && !twoFaRequired) {
      toast.error("Please complete the human verification");
      return;
    }

    const firstFactor = !twoFaRequired;
    const verificationToken = firstFactor ? turnstileToken : "";
    submitInFlight.current = true;
    if (firstFactor) setTurnstileToken("");
    try {
      await login(email, password, verificationToken, twoFaToken || undefined);
      // login() resolves → tokens are set → request assertion
      await requestAssertion();
    } catch (err: any) {
      // 2FA challenge — show the code input instead of redirecting
      if (err.message?.startsWith("2FA_REQUIRED")) {
        const method = err.message.split(":")[1] || "totp";
        setTwoFaRequired(true);
        setTwoFaMethod(method);
        toast.info(
          method === "email"  ? "A verification code was sent to your email"
          : method === "static" ? "Enter one of your backup codes"
          :                       "Enter the code from your authenticator app",
        );
        return;
      }

      // A failed credential attempt must never exchange an unrelated old token.
      // A newly authenticated session is handled by the hydration effect above.
      toast.error(err.message || t("auth.loginFailed"));
    } finally {
      // A completed or ambiguous first-factor request has spent its challenge.
      // Remount to obtain a fresh token while retaining the separate 2FA step.
      if (firstFactor) {
        setTurnstileToken("");
        setChallengeVersion(version => version + 1);
      }
      submitInFlight.current = false;
    }
  };

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md space-y-6">

        {/* Header */}
        <div className="text-center">
          <img
            src="/favicon-128.png"
            alt="Amma Wallet"
            className="w-16 h-16 mx-auto mb-4 rounded-2xl"
          />
          <h1 className="text-2xl font-bold text-stellar-text">Sign in to continue</h1>
        </div>

        {/* SSO context banner */}
        <div className="rounded-xl border border-stellar-blue/30 bg-stellar-blue/10 px-4 py-3">
          <p className="text-sm font-semibold text-stellar-text mb-0.5">
            <span className="text-stellar-link">{rpOrigin}</span> is requesting access to your AmmaWallet.
          </p>
          <p className="text-xs text-stellar-muted leading-relaxed">
            After signing in, you will be returned there automatically.
          </p>
        </div>

        {pageError && (
          <div className="rounded-lg bg-red-900/30 border border-red-700 text-red-700 dark:text-red-300 text-sm px-4 py-3">
            {pageError}
          </div>
        )}

        {/* Login form */}
        <form
          onSubmit={handleSubmit}
          className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6"
        >
          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-stellar-muted mb-1.5">
              {t("auth.emailOrPhone", "Email or phone number")}
            </label>
            <div className="relative">
              <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
              <input
                aria-label="Email or phone number" type="text" autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com or +27123456789"
                autoFocus
                className="w-full pl-10 pr-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue transition-colors"
              />
            </div>
          </div>

          {/* Password */}
          <div>
            <label className="block text-sm font-medium text-stellar-muted mb-1.5">
              {t("auth.password")}
            </label>
            <div className="relative">
              <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("auth.passwordPlaceholder")}
                className="w-full pl-10 pr-12 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-stellar-muted hover:text-stellar-text transition-colors"
              >
                {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
              </button>
            </div>
          </div>

          <div className="text-right">
            <Link
              to="/forgot-password"
              className="inline-flex min-h-11 items-center text-sm text-stellar-link hover:text-stellar-purple transition-colors"
            >
              {t("auth.forgotPassword")}?
            </Link>
          </div>

          {/* 2FA code input */}
          {twoFaRequired && (
            <div className="space-y-2">
              <label className="block text-sm text-stellar-muted">2FA Verification Code</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={8}
                value={twoFaToken}
                onChange={(e) => setTwoFaToken(e.target.value.replace(/[^0-9A-Za-z]/g, ""))}
                placeholder={
                  twoFaMethod === "email"  ? "Enter email code"
                  : twoFaMethod === "static" ? "Enter your security code"
                  :                           "Enter 6-digit code or backup code"
                }
                className="w-full px-4 py-3 rounded-xl bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue text-center text-lg tracking-widest"
                autoFocus
              />
              <p className="text-xs text-stellar-muted text-center">
                {twoFaMethod === "email"  ? "Check your email for a 6-digit code"
                : twoFaMethod === "static" ? "Enter one of your 8-character backup codes"
                :                            "Enter code from your authenticator app, or an 8-character backup code"}
              </p>
            </div>
          )}

          <Turnstile
            key={challengeVersion}
            siteKey="0x4AAAAAAD2WUNs4ywHK6utW"
            onVerify={(token) => setTurnstileToken(token)}
            onExpire={() => setTurnstileToken("")}
            onError={() => setTurnstileToken("")}
          />

          <button
            type="submit"
            disabled={isLoading || (!turnstileToken && !twoFaRequired)}
            className="w-full py-3 rounded-lg bg-stellar-blue text-white font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <><Loader2 size={18} className="animate-spin" /> {t("auth.signingIn")}</>
            ) : (
              <>{t("auth.signIn")} <ArrowRight size={16} /></>
            )}
          </button>
        </form>

        <p className="text-center text-sm text-stellar-muted">
          Don&apos;t have an AmmaWallet account?{" "}
          <Link
            to="/register"
            className="text-stellar-link hover:text-stellar-purple transition-colors font-medium"
          >
            {t("auth.createOne")}
          </Link>
        </p>
      </div>
    </main>
  );
}
