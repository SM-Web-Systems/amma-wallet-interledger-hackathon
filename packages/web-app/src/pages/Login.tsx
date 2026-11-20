import { BrandMark } from "../components/BrandMark";
import { useRef, useState } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { useWalletStore } from "../store/wallet";
import { postLoginPath, isLmsClaimReturn } from "../lib/post-login-path";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Eye, EyeOff, Mail, Lock, Loader2 } from "lucide-react";
import { Turnstile } from "../components/Turnstile";
import { approvalReturnPath } from "../lib/xrpl/approval-link";
import { xrplEnabled } from "../lib/xrpl/feature";
import { consumePendingOAuth, peekPendingOAuth } from "../lib/pending-oauth";
import { paymentReturnPath } from '../lib/payment-return';

export default function LoginPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [challengeVersion, setChallengeVersion] = useState(0);
  const submitInFlight = useRef(false);
  const [lockedMessage, setLockedMessage] = useState("");
  const [formError, setFormError] = useState("");
  const [errorN, setErrorN] = useState(0);
  const [twoFaRequired, setTwoFaRequired] = useState(false);
  const [twoFaToken, setTwoFaToken] = useState("");
  const [twoFaMethod, setTwoFaMethod] = useState("");
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const navigate = useNavigate();
  const location = useLocation();

  // Inline copy of the error so it stays on screen after the toast is gone. Focus stays put (keeps the phone keyboard open);
  // errorN remounts the alert so an identical repeated error is announced again.
  const showError = (message: string) => { setFormError(message); setErrorN((n) => n + 1); toast.error(message); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlight.current) return;
    setFormError("");
    if (!email || !password) return showError(t("auth.fillAllFields"));
    if (!turnstileToken && !twoFaRequired) return showError("Please complete the human verification");
    // AuthRoute resumes a pending OAuth request as soon as login() flips isAuthenticated
    // (after the wallet sync, so this handler runs second). Remember it so this handler doesn't
    // navigate away from the consent page afterwards.
    const oauthPendingAtSubmit = peekPendingOAuth();
    const firstFactor = !twoFaRequired;
    const verificationToken = firstFactor ? turnstileToken : "";
    submitInFlight.current = true;
    setLockedMessage("");
    if (firstFactor) setTurnstileToken("");
    try {
      await login(email, password, verificationToken, twoFaToken || undefined);
      toast.success(t("auth.welcomeMessage"));
      // Check for pending OAuth flow â€” redirect back to consent page instead of dashboard
      const approval = xrplEnabled ? approvalReturnPath(location.state?.xrplApproval) : null;
      if (approval) { navigate(approval, { replace: true }); return; }
      const paymentReturn = paymentReturnPath(location.state?.paymentReturn);
      if (paymentReturn) { navigate(paymentReturn, { replace: true }); return; }
      const pendingOAuth = consumePendingOAuth();
      if (pendingOAuth) {
        navigate(`/oauth/authorize${pendingOAuth}`, { replace: true });
      } else if (!oauthPendingAtSubmit) {
        const { accounts, activeAccountId } = useWalletStore.getState();
        navigate(postLoginPath({ returnTo: location.state?.returnTo, hasActiveWallet: Boolean(accounts.length && activeAccountId) }));
      }
    } catch (err: any) {
      if (err.message?.startsWith("2FA_REQUIRED")) {
        const method = err.message.split(":")[1] || "totp";
        setTwoFaRequired(true);
        setTwoFaMethod(method);
        toast.info(
          method === "email" ? "A verification code was sent to your email"
          : method === "static" ? "Enter one of your backup codes"
          : "Enter the code from your authenticator app"
        );
      } else if (err.status === 423) {
        // Locked after too many wrong passwords: say when it opens, and offer a reset, inline.
        const opens = err.retryAt ? new Date(err.retryAt) : null;
        setLockedMessage(opens && !Number.isNaN(opens.getTime())
          ? `Too many wrong passwords. Sign-in is paused until ${opens.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. You can reset your password now.`
          : err.message || "Too many wrong passwords. You can reset your password now.");
      } else {
        showError(err.message || t("auth.loginFailed"));
      }
    } finally {
      // Siteverify consumes a token even when credentials fail or the response is lost.
      // A new first-factor attempt needs a fresh widget, never an automatic login retry.
      if (firstFactor) {
        setTurnstileToken("");
        setChallengeVersion(version => version + 1);
      }
      submitInFlight.current = false;
    }
  };

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <BrandMark size={64} className="mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-stellar-text">{t("auth.welcomeBack")}</h1>
          <p className="mt-2 text-stellar-muted">{t("auth.signInSubtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6">
          <div>
            <label htmlFor="wallet-login-identifier" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.emailOrPhone", "Email or phone number")}</label>
            <div className="relative">
              <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
              <input
                id="wallet-login-identifier" type="text" autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com or +27123456789"
                autoFocus
                className="w-full pl-10 pr-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue transition-colors"
              />
            </div>
          </div>

          <div>
            <label htmlFor="wallet-login-password" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.password")}</label>
            <div className="relative">
              <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
              <input
                id="wallet-login-password"
                autoComplete="current-password"
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
            <Link to="/forgot-password" className="inline-flex min-h-11 items-center text-sm text-stellar-link hover:text-stellar-purple transition-colors">
              {t("auth.forgotPassword")}?
            </Link>
          </div>

          {/* 2FA Code Input */}
          {twoFaRequired && (
            <div className="space-y-2">
              <label htmlFor="wallet-login-2fa" className="block text-sm text-stellar-muted">2FA Verification Code</label>
              <input
                id="wallet-login-2fa"
                autoComplete="one-time-code"
                type="text"
                inputMode="numeric"
                maxLength={8}
                value={twoFaToken}
                onChange={(e) => setTwoFaToken(e.target.value.replace(/[^0-9A-Za-z]/g, ""))}
                placeholder={twoFaMethod === "email" ? "Enter email code" : twoFaMethod === "static" ? "Enter your security code" : "Enter 6-digit code or backup code"}
                className="w-full px-4 py-3 rounded-xl bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue text-center text-lg tracking-widest"
                autoFocus
              />
              <p className="text-xs text-stellar-muted text-center">
                {twoFaMethod === "email" ? "Check your email for a 6-digit code" : twoFaMethod === "static" ? "Enter one of your 8-character backup codes" : "Enter code from your authenticator app, or an 8-character backup code"}
              </p>
            </div>
          )}

          {lockedMessage && (
            <div role="alert" className="rounded-lg border border-stellar-border bg-stellar-dark p-3 text-sm text-stellar-text space-y-1">
              <p>{lockedMessage}</p>
              <Link to="/forgot-password" className="inline-flex min-h-11 items-center font-medium text-stellar-link hover:text-stellar-purple transition-colors">
                Reset password
              </Link>
            </div>
          )}

          {formError && (
            <div key={errorN} role="alert" className="rounded-lg border border-red-600/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
              {formError}
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
              <>
                <Loader2 size={18} className="animate-spin" />
                {t("auth.signingIn")}
              </>
            ) : (
              t("auth.signIn")
            )}
          </button>
        </form>

        <p className="text-center text-sm text-stellar-muted">
          {t("auth.noAccount")}{" "}
          <Link to="/register" state={isLmsClaimReturn(location.state?.returnTo) ? { returnTo: location.state.returnTo } : undefined} className="inline-flex min-h-11 items-center text-stellar-link hover:text-stellar-purple transition-colors font-medium">
            {t("auth.createOne")}
          </Link>
        </p>
      </div>
    </main>
  );
}
