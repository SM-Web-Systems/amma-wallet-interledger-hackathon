import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Mail, Lock, Loader2, ArrowLeft, CheckCircle } from "lucide-react";
import PasswordRules from "../components/PasswordRules";
import { localZaToE164 } from "../lib/za-phone";

const API_BASE = import.meta.env.VITE_API_URL || "";

// No "@", and only digits, "+", spaces, dashes, dots and brackets: treat as a phone number.
const looksLikePhone = (input: string) => !input.includes("@") && /^[+\d][\d\s\-().]*$/.test(input);
// The server only accepts E.164 with the country code (it cannot read 082...).
const toE164 = (input: string) => localZaToE164(input.trim()).replace(/[\s\-().]/g, "");
const RESEND_SECONDS = 60;
const isE164 = (value: string) => /^\+\d{8,15}$/.test(value);

const inputClass =
  "w-full pl-10 pr-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue transition-colors";
const buttonClass =
  "w-full py-3 rounded-lg bg-stellar-blue text-white font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50 flex items-center justify-center gap-2";

async function post(path: string, body: Record<string, string>) {
  return fetch(`${API_BASE}/api/v1/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Step = "identify" | "emailSent" | "code" | "done";

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState("");
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState<Step>("identify");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setErrorText] = useState("");
  const [errorField, setErrorField] = useState<"id" | "code" | "password">("id");
  const [errorN, setErrorN] = useState(0);
  const [notice, setNotice] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const idRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  const setError = (text: string, field: "id" | "code" | "password" = "id") => {
    setErrorText(text);
    setErrorField(field);
    if (text) setErrorN((n) => n + 1); // new key, so a repeated error is announced again
  };

  const rules = [
    { label: t("auth.rule8chars"), valid: password.length >= 8 },
    { label: t("auth.ruleUppercase"), valid: /[A-Z]/.test(password) },
    { label: t("auth.ruleLowercase"), valid: /[a-z]/.test(password) },
    { label: t("auth.ruleNumber"), valid: /\d/.test(password) },
    { label: t("auth.ruleMatch"), valid: password.length > 0 && password === confirmPassword },
  ];

  // Move focus to the field that has the error.
  useEffect(() => {
    if (!errorN) return;
    (errorField === "password" ? pwRef : errorField === "code" ? codeRef : idRef).current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorN]);

  // Resend countdown.
  const counting = cooldown > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  const handleIdentify = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = identifier.trim();
    setError("");
    if (!value) return setError(t("auth.identifierRequired"));
    const isPhone = looksLikePhone(value);
    const e164 = toE164(value);
    if (!isPhone && !value.includes("@")) return setError(t("auth.identifierInvalid"));
    if (isPhone && !isE164(e164)) return setError(t("auth.phoneNeedsCountryCode"));
    setIsLoading(true);
    try {
      const res = isPhone
        ? await post("forgot-password-sms", { phoneNumber: e164 })
        : await post("forgot-password", { email: value });
      if (res.status === 429) return setError(t("auth.tooManyTries"));
      if (!res.ok) throw new Error("request failed");
      if (isPhone) {
        setPhone(e164);
        setNotice(t("auth.resetCodeSent"));
        setCooldown(RESEND_SECONDS);
        setStep("code");
      } else {
        setStep("emailSent");
      }
    } catch {
      setError(isPhone ? t("auth.resetCodeFailed") : t("auth.resetRequestFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    setIsLoading(true);
    try {
      const res = await post("forgot-password-sms", { phoneNumber: phone });
      if (res.status === 429) return setError(t("auth.tooManyTries"), "code");
      if (!res.ok) throw new Error("request failed");
      setNotice(t("auth.newCodeSent"));
      setCode("");
      setCooldown(RESEND_SECONDS);
    } catch {
      setError(t("auth.resendFailed"), "code");
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!/^\d{6}$/.test(code)) return setError(t("auth.codeWrong"), "code");
    if (!rules.every((r) => r.valid)) return setError(t("auth.fixPasswordReqs"), "password");
    setIsLoading(true);
    try {
      const res = await post("reset-password-sms", { phoneNumber: phone, code, newPassword: password });
      if (res.status === 429) return setError(t("auth.tooManyTries"), "code");
      if (res.status === 400) return setError(t("auth.codeWrong"), "code");
      if (!res.ok) throw new Error("request failed");
      setStep("done");
    } catch {
      setError(t("auth.resetFailed"), "code");
    } finally {
      setIsLoading(false);
    }
  };

  const errorBox = (id: string, field: "id" | "code" | "password") =>
    error && errorField === field ? (
      <p key={errorN} id={id} role="alert" className="mt-1.5 text-sm text-red-700 dark:text-red-400">
        {error}
      </p>
    ) : null;

  if (step === "emailSent" || step === "done") {
    const isEmail = step === "emailSent";
    return (
      <main className="flex items-center justify-center min-h-screen p-6">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-green-500/10 flex items-center justify-center">
            <CheckCircle size={32} className="text-green-700 dark:text-green-400" />
          </div>
          <h1 className="text-2xl font-bold text-stellar-text">{isEmail ? t("auth.resetEmailSent") : t("auth.passwordChanged")}</h1>
          {isEmail && <p className="text-stellar-muted">{t("auth.resetEmailSentDesc")}</p>}
          <Link
            to="/login"
            className="inline-flex min-h-11 items-center gap-2 text-stellar-link hover:text-stellar-purple transition-colors font-medium"
          >
            <ArrowLeft size={16} />
            {isEmail ? t("auth.backToLogin") : t("auth.signInLink")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <img src="/favicon-128.png" alt="Amma Wallet" className="w-16 h-16 mx-auto mb-4 rounded-2xl" />
          <h1 className="text-3xl font-bold text-stellar-text">{t("auth.forgotPassword")}</h1>
          <p className="mt-2 text-stellar-muted">{step === "code" ? t("auth.enterCodeDesc") : t("auth.forgotPasswordDesc")}</p>
        </div>

        {step === "identify" ? (
          <form onSubmit={handleIdentify} className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6">
            <div>
              <label htmlFor="forgot-identifier" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.emailOrPhone")}</label>
              <div className="relative">
                <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
                <input
                  id="forgot-identifier"
                  ref={idRef}
                  type="text"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder={t("auth.emailOrPhonePlaceholder")}
                  aria-invalid={!!error}
                  aria-describedby={error ? "forgot-identifier-error" : undefined}
                  autoFocus
                  className={inputClass}
                />
              </div>
              {errorBox("forgot-identifier-error", "id")}
            </div>
            <button type="submit" disabled={isLoading} className={buttonClass}>
              {isLoading ? (<><Loader2 size={18} className="animate-spin" />{t("auth.sending")}</>) : t("auth.continue")}
            </button>
          </form>
        ) : (
          <form onSubmit={handleReset} className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6">
            <p role="status" className="text-sm text-stellar-muted">{notice}</p>
            <div>
              <label htmlFor="forgot-code" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.codeLabel")}</label>
              <input
                id="forgot-code"
                ref={codeRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                aria-invalid={!!error && errorField === "code"}
                aria-describedby={error && errorField === "code" ? "forgot-code-error" : undefined}
                autoFocus
                className="w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text tracking-widest focus:outline-none focus:border-stellar-blue transition-colors"
              />
              {errorBox("forgot-code-error", "code")}
              <button
                type="button"
                onClick={handleResend}
                disabled={isLoading || cooldown > 0}
                className="mt-1 inline-flex min-h-11 items-center text-sm text-stellar-link hover:text-stellar-purple transition-colors font-medium disabled:opacity-50"
              >
                {cooldown > 0 ? `${t("auth.sendNewCodeIn")} ${cooldown}s` : t("auth.sendNewCode")}
              </button>
            </div>

            <div>
              <label htmlFor="forgot-new-password" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.newPasswordLabel")}</label>
              <div className="relative">
                <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
                <input id="forgot-new-password" ref={pwRef} aria-invalid={!!error && errorField === "password"} aria-describedby={error && errorField === "password" ? "forgot-password-error" : undefined} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
              </div>
              {errorBox("forgot-password-error", "password")}
            </div>
            <div>
              <label htmlFor="forgot-confirm-password" className="block text-sm font-medium text-stellar-muted mb-1.5">{t("auth.confirmPassword")}</label>
              <div className="relative">
                <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-stellar-muted" />
                <input id="forgot-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} />
              </div>
            </div>

            <PasswordRules rules={rules} />

            <button type="submit" disabled={isLoading} className={buttonClass}>
              {isLoading ? (<><Loader2 size={18} className="animate-spin" />{t("auth.sending")}</>) : t("auth.changePassword")}
            </button>
          </form>
        )}

        <p className="text-center text-sm text-stellar-muted">
          <Link to="/login" className="text-stellar-link hover:text-stellar-purple transition-colors font-medium inline-flex min-h-11 items-center gap-1">
            <ArrowLeft size={14} />
            {t("auth.backToLogin")}
          </Link>
        </p>
      </div>
    </main>
  );
}
