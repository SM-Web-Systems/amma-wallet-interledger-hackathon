import { useState, useEffect } from "react";
import { passphraseProblem } from "../lib/passphrase";
import { normalizeMnemonic, RECOVERY_WORD_COUNTS, type RecoveryWordCount } from "../lib/hd-wallet";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { xrplEnabled } from "../lib/xrpl/feature";
import { evmEnabled } from "../lib/evm/feature";
import { useWalletStore } from "../store/wallet";
import { toast } from "sonner";
import { mainnetCustodyBuild, xrplMainnetBuild, xrplNetworkShown } from "../lib/custody-network";
import SecretKeyBackup from "../components/SecretKeyBackup";
import { Copy, Check, Eye, EyeOff, AlertTriangle, ShieldCheck } from "lucide-react";

export default function OnboardingPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const actionParam = searchParams.get("action");

  const [mode, setMode] = useState<
    "choice" | "create" | "create-mnemonic" | "import" | "import-mnemonic"
  >("choice");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [generatedMnemonic, setGeneratedMnemonic] = useState("");
  const [mnemonicConfirmed, setMnemonicConfirmed] = useState(false);
  const [mnemonicConfirmInput, setMnemonicConfirmInput] = useState("");
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [wordCount, setWordCount] = useState<RecoveryWordCount>(24);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"form" | "backup" | "confirm">("form");

  const accounts = useWalletStore((s) => s.accounts);
  const activeAccountId = useWalletStore((s) => s.activeAccountId);
  const createWallet = useWalletStore((s) => s.createWallet);
  const importWallet = useWalletStore((s) => s.importWallet);
  const generateMnemonic = useWalletStore((s) => s.generateMnemonic);
  const createWalletFromMnemonic = useWalletStore((s) => s.createWalletFromMnemonic);
  const importFromMnemonic = useWalletStore((s) => s.importFromMnemonic);
  const navigate = useNavigate();

  const isAddingToExisting = accounts.length > 0;

  useEffect(() => {
    if (actionParam === "create") setMode("create");
    if (actionParam === "import") setMode("import");
    if (actionParam === "create-mnemonic") setMode("create-mnemonic");
    if (actionParam === "import-mnemonic") setMode("import-mnemonic");
  }, [actionParam]);

  const resetForm = () => {
    setPin("");
    setConfirmPin("");
    setSecretInput("");
    setMnemonicInput("");
    setGeneratedMnemonic("");
    setMnemonicConfirmed(false);
    setMnemonicConfirmInput("");
    setShowMnemonic(false);
    setCopied(false);
    setName("");
    setStep("form");
  };

  const handleBack = () => {
    if (step === "confirm") {
      setStep("backup");
      setMnemonicConfirmInput("");
      return;
    }
    if (step === "backup") {
      setStep("form");
      return;
    }
    if (isAddingToExisting) {
      navigate("/dashboard");
    } else {
      setMode("choice");
    }
    resetForm();
  };

  const handleCopyMnemonic = async () => {
    await navigator.clipboard.writeText(generatedMnemonic);
    setCopied(true);
    toast.success(t("onboarding.mnemonicCopied", "Recovery phrase copied!"));
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Create (random keypair) ──
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const pinProblem = passphraseProblem(pin);
    if (pinProblem) return toast.error(pinProblem);
    if (pin !== confirmPin) return toast.error(t("onboarding.passphraseMismatch", "The passphrases do not match."));
    setLoading(true);
    try {
      const walletName = name.trim() || `Wallet ${accounts.length + 1}`;
      const pk = await createWallet(walletName, pin);
      toast.success(`${walletName}: ${pk.slice(0, 8)}...`);
      resetForm(); // the secret-key backup step takes over until the person confirms it
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Import (secret key) ──
  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    const pinProblem = passphraseProblem(pin);
    if (pinProblem) return toast.error(pinProblem);
    if (pin !== confirmPin) return toast.error(t("onboarding.passphraseMismatch", "The passphrases do not match."));
    if (!secretInput.startsWith("S") || secretInput.length !== 56)
      return toast.error(t("onboarding.secretKeyInvalid"));
    setLoading(true);
    try {
      const walletName = name.trim() || `Imported ${accounts.length + 1}`;
      const pk = await importWallet(walletName, secretInput, pin);
      toast.success(`${walletName}: ${pk.slice(0, 8)}...`);
      resetForm();
      navigate("/dashboard");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Create from mnemonic ──
  const handleGenerateMnemonic = async (e: React.FormEvent) => {
    e.preventDefault();
    const pinProblem = passphraseProblem(pin);
    if (pinProblem) return toast.error(pinProblem);
    if (pin !== confirmPin) return toast.error(t("onboarding.passphraseMismatch", "The passphrases do not match."));
    const mnemonic = await generateMnemonic(wordCount);
    setGeneratedMnemonic(mnemonic);
    setStep("backup");
  };

  const handleConfirmMnemonic = () => {
    if (normalizeMnemonic(mnemonicConfirmInput) !== normalizeMnemonic(generatedMnemonic)) {
      return toast.error(
        t("onboarding.mnemonicMismatch", "Recovery phrase does not match. Please try again.")
      );
    }
    setMnemonicConfirmed(true);
    setStep("confirm");
  };

  const handleCreateFromMnemonic = async () => {
    setLoading(true);
    try {
      const walletName = name.trim() || `HD Wallet ${accounts.length + 1}`;
      const result = await createWalletFromMnemonic({ name: walletName, pin, mnemonic: generatedMnemonic });
      const pk = typeof result === "string" ? result : result.publicKey;
      toast.success(`${walletName}: ${pk.slice(0, 8)}...`);
      resetForm();
      navigate("/dashboard");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── Import from mnemonic ──
  const handleImportFromMnemonic = async (e: React.FormEvent) => {
    e.preventDefault();
    const pinProblem = passphraseProblem(pin);
    if (pinProblem) return toast.error(pinProblem);
    if (pin !== confirmPin) return toast.error(t("onboarding.passphraseMismatch", "The passphrases do not match."));
    const words = normalizeMnemonic(mnemonicInput).split(" ");
    if (words.length !== 12 && words.length !== 24) {
      return toast.error(
        t("onboarding.mnemonicInvalid", "Enter a valid 12 or 24-word recovery phrase.")
      );
    }
    setLoading(true);
    try {
      const walletName = name.trim() || `Recovered ${accounts.length + 1}`;
      const pk = await importFromMnemonic(walletName, normalizeMnemonic(mnemonicInput), pin);
      toast.success(`${walletName}: ${pk.slice(0, 8)}...`);
      resetForm();
      navigate("/dashboard");
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (accounts.find((a) => a.id === activeAccountId)?.backupPending) return <SecretKeyBackup />;

  // ── Shared input classes ──
  const inputClass =
    "w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue";
  const btnPrimary =
    "w-full py-3 rounded-lg bg-stellar-blue text-white font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50";
  const btnSecondary = "w-full text-sm text-stellar-muted hover:text-stellar-text transition-colors";
  const backLabel = isAddingToExisting ? t("common.cancel") : t("common.back");

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md space-y-8">
        {((xrplEnabled && xrplNetworkShown()) || evmEnabled) && (
          <nav aria-label="Other wallets" className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
            {xrplEnabled && xrplNetworkShown() && <Link to="/xrpl" className="ui-link">{xrplMainnetBuild() ? "Open XRP wallets" : "Open XRP Testnet wallets"}</Link>}
            {evmEnabled && <Link to="/ethereum-sepolia" className="ui-link">{mainnetCustodyBuild() ? "Open Ethereum wallets" : "Open Ethereum Sepolia wallets"}</Link>}
          </nav>
        )}
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold text-stellar-text">{t("onboarding.title")}</h1>
          <p className="mt-2 text-stellar-muted">
            {isAddingToExisting ? t("onboarding.subtitleAdd") : t("onboarding.subtitle")}
          </p>
          {isAddingToExisting && (
            <p className="mt-1 text-xs text-stellar-muted">
              {t("onboarding.youHaveWallets", { count: accounts.length })}
            </p>
          )}
        </div>

        {/* ── Choice ── */}
        {mode === "choice" && (
          <div className="space-y-4">
            <div className="space-y-3">
              <p className="text-sm font-medium text-stellar-muted uppercase tracking-wide">
                {t("onboarding.newWallet", "New Wallet")}
              </p>
              <button
                onClick={() => setMode("create-mnemonic")}
                className="w-full py-4 rounded-xl bg-stellar-blue text-white font-semibold text-lg hover:bg-stellar-purple transition-colors flex items-center justify-center gap-2"
              >
                <ShieldCheck size={20} />
                {t("onboarding.createWithSeed", "Create with Recovery Phrase")}
              </button>
              <button
                onClick={() => setMode("create")}
                className="w-full py-3 rounded-xl border border-stellar-border text-stellar-text font-medium hover:bg-stellar-hover transition-colors"
              >
                {t("onboarding.createQuick", "Quick Create (keypair only)")}
              </button>
            </div>

            <div className="space-y-3 pt-2">
              <p className="text-sm font-medium text-stellar-muted uppercase tracking-wide">
                {t("onboarding.existingWallet", "Existing Wallet")}
              </p>
              <button
                onClick={() => setMode("import-mnemonic")}
                className="w-full py-3 rounded-xl border border-stellar-border text-stellar-text font-medium hover:bg-stellar-hover transition-colors"
              >
                {t("onboarding.importFromSeed", "Import from Recovery Phrase")}
              </button>
              <button
                onClick={() => setMode("import")}
                className="w-full py-3 rounded-xl border border-stellar-border text-stellar-text font-medium hover:bg-stellar-hover transition-colors"
              >
                {t("onboarding.importFromSecret", "Import from Secret Key")}
              </button>
            </div>

            {isAddingToExisting && (
              <button
                onClick={() => navigate("/dashboard")}
                className="w-full text-sm text-stellar-muted hover:text-stellar-text transition-colors pt-2"
              >
                {t("onboarding.cancelBack")}
              </button>
            )}
          </div>
        )}

        {/* ── Create (random keypair) ── */}
        {mode === "create" && (
          <form
            onSubmit={handleCreate}
            className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6"
          >
            <h2 className="text-lg font-semibold text-stellar-text">
              {isAddingToExisting
                ? t("onboarding.addNewWallet")
                : t("onboarding.createWallet")}
            </h2>
            <p className="text-sm text-stellar-muted">
              {t(
                "onboarding.createQuickDesc",
                "Creates a random Stellar keypair. You'll get a secret key but no recovery phrase."
              )}
            </p>
            <input
              type="text"
              placeholder={t("onboarding.walletNamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className={inputClass}
            />
            <input
              type="password"
              placeholder={t("onboarding.enterPassphrase", "Choose a passphrase (12+ characters)")}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className={inputClass}
            />
            <input
              type="password"
              placeholder={t("onboarding.confirmPassphrase", "Confirm passphrase")}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              className={inputClass}
            />
            <button type="submit" disabled={loading} className={btnPrimary}>
              {loading ? t("onboarding.creating") : t("onboarding.createWallet")}
            </button>
            <button type="button" onClick={handleBack} className={btnSecondary}>
              {backLabel}
            </button>
          </form>
        )}

        {/* ── Create from Mnemonic ── */}
        {mode === "create-mnemonic" && step === "form" && (
          <form
            onSubmit={handleGenerateMnemonic}
            className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6"
          >
            <h2 className="text-lg font-semibold text-stellar-text flex items-center gap-2">
              <ShieldCheck size={20} className="text-stellar-link" />
              {t("onboarding.createWithSeedTitle", "Create HD Wallet")}
            </h2>
            <p className="text-sm text-stellar-muted">
              {t("onboarding.createWithSeedDescCount", {
                count: wordCount,
                defaultValue: "Generates a {{count}}-word recovery phrase. Back it up safely — it's the only way to recover your wallet.",
              })}
            </p>
            <fieldset>
              <legend className="ui-label">{t("onboarding.phraseLength", "Recovery phrase length")}</legend>
              <div className="grid grid-cols-2 gap-2">
                {RECOVERY_WORD_COUNTS.map((n) => (
                  <label
                    key={n}
                    className={`flex cursor-pointer flex-col rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-stellar-purple ${
                      wordCount === n
                        ? "border-stellar-blue bg-stellar-blue/10 text-stellar-text"
                        : "border-stellar-border text-stellar-muted hover:text-stellar-text"
                    }`}
                  >
                    <input
                      type="radio"
                      name="recovery-word-count"
                      value={n}
                      checked={wordCount === n}
                      onChange={() => setWordCount(n)}
                      className="sr-only"
                      aria-describedby={n === 24 ? "recommended-24" : undefined}
                    />
                    {t("onboarding.wordsOption", { count: n, defaultValue: "{{count}} words" })}
                    {n === 24 && <span id="recommended-24" className="block text-xs font-normal text-stellar-muted">{t("onboarding.recommended", "Recommended")}</span>}
                  </label>
                ))}
              </div>
            </fieldset>
            <input
              type="text"
              placeholder={t("onboarding.walletNamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className={inputClass}
            />
            <input
              type="password"
              placeholder={t("onboarding.enterPassphrase", "Choose a passphrase (12+ characters)")}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className={inputClass}
            />
            <input
              type="password"
              placeholder={t("onboarding.confirmPassphrase", "Confirm passphrase")}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              className={inputClass}
            />
            <button type="submit" className={btnPrimary}>
              {t("onboarding.generatePhrase", "Generate Recovery Phrase")}
            </button>
            <button type="button" onClick={handleBack} className={btnSecondary}>
              {backLabel}
            </button>
          </form>
        )}

        {mode === "create-mnemonic" && step === "backup" && (
          <div className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-stellar-text">
              {t("onboarding.backupTitle", "Back Up Your Recovery Phrase")}
            </h2>

            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              <AlertTriangle size={18} className="text-yellow-700 dark:text-yellow-400 shrink-0 mt-0.5" />
              <p className="text-sm text-yellow-700 dark:text-yellow-300">
                {t("onboarding.backupWarningCount", {
                  count: generatedMnemonic.split(" ").length,
                  defaultValue: "Write down these {{count}} words in order. Never share them. Anyone with this phrase can access your funds.",
                })}
              </p>
            </div>

            <div className="relative">
              <div
                className={`grid grid-cols-3 gap-2 p-4 rounded-lg bg-stellar-dark border border-stellar-border ${
                  !showMnemonic ? "blur-sm select-none" : ""
                }`}
              >
                {generatedMnemonic.split(" ").map((word, i) => (
                  <div key={i} data-testid="recovery-word" className="flex items-center gap-1.5">
                    <span className="text-xs text-stellar-muted w-5 text-right">{i + 1}.</span>
                    <span className="text-sm text-stellar-text font-mono">{word}</span>
                  </div>
                ))}
              </div>

              {!showMnemonic && (
                <button
                  onClick={() => setShowMnemonic(true)}
                  className="absolute inset-0 flex items-center justify-center gap-2 text-stellar-text font-medium bg-black/40 rounded-lg"
                >
                  <Eye size={18} />
                  {t("onboarding.tapToReveal", "Click to reveal")}
                </button>
              )}
            </div>

            <div className="flex gap-2">
              {showMnemonic && (
                <button
                  onClick={() => setShowMnemonic(false)}
                  className="flex-1 py-2 rounded-lg border border-stellar-border text-sm text-stellar-text hover:bg-stellar-hover flex items-center justify-center gap-1.5"
                >
                  <EyeOff size={14} />
                  {t("common.hide", "Hide")}
                </button>
              )}
              <button
                onClick={handleCopyMnemonic}
                className="flex-1 py-2 rounded-lg border border-stellar-border text-sm text-stellar-text hover:bg-stellar-hover flex items-center justify-center gap-1.5"
              >
                {copied ? <Check size={14} className="text-green-700 dark:text-green-400" /> : <Copy size={14} />}
                {copied ? t("common.copied", "Copied") : t("common.copy", "Copy")}
              </button>
            </div>

            <button
              onClick={() => {
                setStep("confirm");
                setMnemonicConfirmInput("");
              }}
              className={btnPrimary}
            >
              {t("onboarding.iSavedIt", "I've saved my recovery phrase")}
            </button>
            <button type="button" onClick={handleBack} className={btnSecondary}>
              {t("common.back")}
            </button>
          </div>
        )}

        {mode === "create-mnemonic" && step === "confirm" && !mnemonicConfirmed && (
          <div className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-stellar-text">
              {t("onboarding.confirmPhraseTitle", "Confirm Your Recovery Phrase")}
            </h2>
            <p className="text-sm text-stellar-muted">
              {t("onboarding.confirmPhraseDescCount", {
                count: generatedMnemonic.split(" ").length,
                defaultValue: "Type your {{count}}-word recovery phrase below to confirm you've saved it.",
              })}
            </p>
            <textarea
              rows={4}
              placeholder={t("onboarding.confirmPhrasePlaceholderCount", {
                count: generatedMnemonic.split(" ").length,
                defaultValue: "Type your {{count}} words separated by spaces...",
              })}
              value={mnemonicConfirmInput}
              onChange={(e) => setMnemonicConfirmInput(e.target.value)}
              className={`${inputClass} font-mono text-sm resize-none`}
              autoFocus
            />
            <button onClick={handleConfirmMnemonic} className={btnPrimary}>
              {t("onboarding.verifyPhrase", "Verify & Create Wallet")}
            </button>
            <button type="button" onClick={handleBack} className={btnSecondary}>
              {t("common.back")}
            </button>
          </div>
        )}

        {mode === "create-mnemonic" && step === "confirm" && mnemonicConfirmed && (
          <div className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
              <ShieldCheck size={32} className="text-green-700 dark:text-green-400" />
            </div>
            <h2 className="text-lg font-semibold text-stellar-text">
              {t("onboarding.phraseVerified", "Recovery Phrase Verified!")}
            </h2>
            <p className="text-sm text-stellar-muted">
              {t(
                "onboarding.phraseVerifiedDesc",
                "Your recovery phrase has been verified. Click below to create your HD wallet."
              )}
            </p>
            <button
              onClick={handleCreateFromMnemonic}
              disabled={loading}
              className={btnPrimary}
            >
              {loading
                ? t("onboarding.creating")
                : t("onboarding.createWalletNow", "Create Wallet Now")}
            </button>
          </div>
        )}

        {/* ── Import (secret key) ── */}
        {mode === "import" && (
          <form
            onSubmit={handleImport}
            className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6"
          >
            <h2 className="text-lg font-semibold text-stellar-text">
              {isAddingToExisting
                ? t("onboarding.addExistingWallet")
                : t("onboarding.importWallet")}
            </h2>
            <input
              type="text"
              placeholder={t("onboarding.walletNameImportPlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className={inputClass}
            />
            <input
              type="password"
              placeholder={t("onboarding.secretKey")}
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              className={`${inputClass} font-mono text-sm`}
            />
            <input
              type="password"
              placeholder={t("onboarding.enterPassphrase", "Choose a passphrase (12+ characters)")}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className={inputClass}
            />
            <input
              type="password"
              placeholder={t("onboarding.confirmPassphrase", "Confirm passphrase")}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              className={inputClass}
            />
            <button type="submit" disabled={loading} className={btnPrimary}>
              {loading ? t("onboarding.importing") : t("onboarding.importWallet")}
            </button>
            <button type="button" onClick={handleBack} className={btnSecondary}>
              {backLabel}
            </button>
          </form>
        )}

        {/* ── Import from Mnemonic ── */}
        {mode === "import-mnemonic" && (
          <form
            onSubmit={handleImportFromMnemonic}
            className="space-y-4 bg-stellar-card border border-stellar-border rounded-2xl p-6"
          >
            <h2 className="text-lg font-semibold text-stellar-text">
              {t("onboarding.importFromSeedTitle", "Recover from Phrase")}
            </h2>
            <p className="text-sm text-stellar-muted">
              {t(
                "onboarding.importFromSeedDesc",
                "Enter your 12 or 24-word recovery phrase to restore your wallet."
              )}
            </p>
            <input
              type="text"
              placeholder={t("onboarding.walletNameImportPlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className={inputClass}
            />
            <textarea
              rows={3}
              placeholder={t(
                "onboarding.enterMnemonic",
                "Enter your recovery phrase (words separated by spaces)..."
              )}
              value={mnemonicInput}
              onChange={(e) => setMnemonicInput(e.target.value)}
              className={`${inputClass} font-mono text-sm resize-none`}
            />
            <input
              type="password"
              placeholder={t("onboarding.enterPassphrase", "Choose a passphrase (12+ characters)")}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className={inputClass}
            />
            <input
              type="password"
              placeholder={t("onboarding.confirmPassphrase", "Confirm passphrase")}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value)}
              className={inputClass}
            />
            <button type="submit" disabled={loading} className={btnPrimary}>
              {loading
                ? t("onboarding.importing")
                : t("onboarding.recoverWallet", "Recover Wallet")}
            </button>
            <button type="button" onClick={handleBack} className={btnSecondary}>
              {backLabel}
            </button>
          </form>
        )}

        {/* Disclaimer */}
        <p className="text-center text-xs text-stellar-muted">
          {t("onboarding.keysDisclaimer")}
        </p>
      </div>
    </main>
  );
}
