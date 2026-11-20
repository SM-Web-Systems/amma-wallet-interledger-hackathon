import { BrandMark } from "../components/BrandMark";
import { useRef, useState } from "react";
import { useNavigate, Link, useSearchParams, useLocation } from "react-router-dom";
import { useAuthStore } from "../store/auth";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Eye, EyeOff, Mail, Lock, User, Loader2, Check, X } from "lucide-react";
import { Turnstile } from "../components/Turnstile";
import { peekPendingOAuth } from "../lib/pending-oauth";
import { useWalletStore } from "../store/wallet";
import { postLoginPath } from "../lib/post-login-path";

export default function RegisterPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState("");
  const register = useAuthStore((s) => s.register);
  const isLoading = useAuthStore((s) => s.isLoading);
  const [emailTouched, setEmailTouched] = useState(false);
  const [formError, setFormError] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const [errorN, setErrorN] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const isFromLms = searchParams.get("source") === "lms";

  const rules = [
    { label: t("auth.rule8chars"), valid: password.length >= 8 },
    { label: t("auth.ruleUppercase"), valid: /[A-Z]/.test(password) },
    { label: t("auth.ruleLowercase"), valid: /[a-z]/.test(password) },
    { label: t("auth.ruleNumber"), valid: /\d/.test(password) },
    { label: t("auth.ruleMatch"), valid: password.length > 0 && password === confirmPassword },
  ];

  const allValid = rules.every((r) => r.valid);
  const emailInvalid = email.trim() !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const showEmailError = emailTouched && emailInvalid;

  // Inline copy of the error so it stays on screen after the toast is gone. Focus stays put (keeps the phone keyboard open);
  // errorN remounts the alert so an identical repeated error is announced again.
  const showError = (message: string) => { setFormError(message); setErrorN((n) => n + 1); toast.error(message); };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    if (!email) return showError(t("auth.fillAllFields"));
    if (emailInvalid) { setEmailTouched(true); emailRef.current?.focus(); return; }
    if (!allValid) return showError(t("auth.fixPasswordReqs"));
    if (!turnstileToken) return showError("Please complete the human verification");
    try {
      await register(email, password, firstName || undefined, lastName || undefined, turnstileToken);
      toast.success(t("auth.accountCreated"));
      // Signed up in the middle of an app's sign-in: AuthRoute takes the user back to consent.
      if (peekPendingOAuth()) return;
      // Same landing as login: an LMS claim first, then the Amma wallets on the dashboard, else onboarding (WA-06).
      const { accounts, activeAccountId } = useWalletStore.getState();
      navigate(postLoginPath({ returnTo: location.state?.returnTo, hasActiveWallet: Boolean(accounts.length && activeAccountId) }), { replace: true });
    } catch (err: any) {
      showError(err.message || t("auth.registerFailed"));
    }
  };

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <BrandMark size={64} className="mx-auto mb-4" />
          <h1 className="text-3xl font-bold text-stellar-text">{t("auth.createAccount")}</h1>
          <p className="mt-2 text-stellar-muted">{t("auth.createSubtitle")}</p>
        </div>

        {isFromLms && (
          <div className="rounded-xl border border-stellar-blue/30 bg-stellar-blue/10 px-4 py-3">
            <p className="text-sm font-semibold text-stellar-text mb-0.5">LMS enrollment</p>
            <p className="text-xs text-stellar-muted leading-relaxed">
              Create this wallet to receive your NFT course certificates on the Stellar blockchain.
              Once registered, return to the LMS and sign in with AmmaWallet to link your account.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="register-first-name" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.firstName")}</label>
              <div className="relative">
                <User size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
                <input
                  id="register-first-name"
                  name="firstName"
                  autoComplete="given-name"
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder={t("auth.firstNamePlaceholder")}
                  className="w-full pl-10 pr-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue transition-colors"
                />
              </div>
            </div>
            <div>
              <label htmlFor="register-last-name" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.lastName")}</label>
              <input
                id="register-last-name"
                name="lastName"
                autoComplete="family-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={t("auth.lastNamePlaceholder")}
                className="w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue transition-colors"
              />
            </div>
          </div>

          <div>
            <label htmlFor="register-email" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.email")}</label>
            <div className="relative">
              <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
              <input
                id="register-email"
                name="email"
                autoComplete="email"
                type="email"
                value={email}
                ref={emailRef}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => setEmailTouched(true)}
                aria-invalid={showEmailError || undefined}
                aria-describedby={showEmailError ? "register-email-error" : undefined}
                placeholder={t("auth.emailPlaceholder")}
                autoFocus
                className="w-full pl-10 pr-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue transition-colors"
              />
            </div>
            {showEmailError && (
              <p id="register-email-error" role="alert" className="mt-1.5 text-sm text-red-700 dark:text-red-300">
                {t("auth.emailInvalid", "Enter a full email address, like name@example.com.")}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="register-password" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.password")}</label>
            <div className="relative">
              <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
              <input
                id="register-password"
                name="password"
                autoComplete="new-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("auth.createPassword")}
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

          <div>
            <label htmlFor="register-confirm-password" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.confirmPassword")}</label>
            <div className="relative">
              <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
              <input
                id="register-confirm-password"
                name="confirmPassword"
                autoComplete="new-password"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t("auth.repeatPassword")}
                className="w-full pl-10 pr-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue transition-colors"
              />
            </div>
          </div>

          <div className="space-y-1.5 pt-1">
            {rules.map((rule, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                {rule.valid ? (
                  <Check size={14} className="text-green-700 dark:text-green-400" />
                ) : (
                  <X size={14} className="text-stellar-muted" />
                )}
                <span className={rule.valid ? "text-green-700 dark:text-green-400" : "text-stellar-muted"}>
                  {rule.label}
                </span>
              </div>
            ))}
          </div>

          {formError && (
            <div key={errorN} role="alert" className="rounded-lg border border-red-600/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
              {formError}
            </div>
          )}

          <Turnstile
            siteKey="0x4AAAAAAD2WUNs4ywHK6utW"
            onVerify={(token) => setTurnstileToken(token)}
            onExpire={() => setTurnstileToken("")}
          />

          <button
            type="submit"
            disabled={isLoading || !allValid || !turnstileToken}
            className="w-full py-3 rounded-lg bg-stellar-blue text-white font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                {t("auth.creatingAccount")}
              </>
            ) : (
              t("auth.createAccount")
            )}
          </button>
        </form>

        <p className="text-center text-sm text-stellar-muted">
          {t("auth.hasAccount")}{" "}
          <Link to="/login" className="inline-flex min-h-11 items-center text-stellar-link hover:text-stellar-purple transition-colors font-medium">
            {t("auth.signInLink")}
          </Link>
        </p>
      </div>
    </main>
  );
}
