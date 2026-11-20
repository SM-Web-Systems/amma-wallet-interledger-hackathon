import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Eye, EyeOff } from "lucide-react";
import { useWalletStore } from "../store/wallet";

/**
 * A new random-key wallet has no recovery phrase and no server copy, so this browser holds the only key.
 * The wallet stays gated (see ProtectedRoute) until the person confirms they wrote the secret key down.
 */
export default function SecretKeyBackup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const account = useWalletStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const unlocked = useWalletStore((s) => s.isUnlocked && !!s._secretKey);
  const storagePersisted = useWalletStore((s) => s.storagePersisted);
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [typed, setTyped] = useState("");

  if (!account) return null;
  const secret = unlocked ? useWalletStore.getState()._secretKey! : null;
  const matches = !!secret && typed.trim() === secret.slice(-6);

  const unlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await useWalletStore.getState().unlock(passphrase);
      setPassphrase("");
    } catch (err: any) {
      setError(err.message || "Incorrect wallet passphrase");
    }
  };

  const confirm = async () => {
    setSaving(true);
    await useWalletStore.getState().confirmBackup(account.id);
    navigate("/dashboard");
  };

  const inputClass = "w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue";
  const btnPrimary = "w-full py-3 rounded-lg bg-stellar-blue text-white font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50";

  return (
    <main className="flex items-center justify-center min-h-screen p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-stellar-text">{t("onboarding.keyBackupTitle", "Save your secret key")}</h1>
          <p className="mt-2 text-sm text-stellar-muted">
            {t("onboarding.keyBackupBody", "This wallet has no recovery phrase and Amma does not hold a copy. The only copy is in this browser. If it is cleared, the wallet and any funds in it are lost. Write the secret key down and keep it offline.")}
          </p>
        </div>

        {storagePersisted === false && (
          <div role="alert" className="flex gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-sm text-yellow-700 dark:text-yellow-300">
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <span>{t("onboarding.storageNotPersistent", "This browser may clear data saved for this site, for example after a week without a visit. Writing the secret key down is the only way to be safe.")}</span>
          </div>
        )}

        {!secret ? (
          <form onSubmit={unlock} className="space-y-3">
            <label htmlFor="backup-passphrase" className="block text-sm text-stellar-muted">{t("onboarding.walletPassphrase", "Wallet passphrase")}</label>
            <input id="backup-passphrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" className={inputClass} />
            {error && <p className="text-sm text-stellar-danger-text">{error}</p>}
            <button type="submit" disabled={passphrase.length < 6} className={btnPrimary}>{t("onboarding.unlock", "Unlock")}</button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="p-4 rounded-lg border border-stellar-border bg-stellar-dark">
              {shown ? (
                <code className="block break-all text-sm text-stellar-text select-all">{secret}</code>
              ) : (
                <p className="text-sm text-stellar-muted">{t("onboarding.keyHidden", "Hidden. Make sure nobody is watching your screen.")}</p>
              )}
            </div>
            <button type="button" onClick={() => setShown((v) => !v)} className="w-full flex items-center justify-center gap-2 py-3 rounded-lg border border-stellar-border text-stellar-text hover:bg-stellar-hover transition-colors">
              {shown ? <EyeOff size={18} /> : <Eye size={18} />}
              {shown ? t("onboarding.hideKey", "Hide secret key") : t("onboarding.showKey", "Show secret key")}
            </button>
            <div>
              <label htmlFor="backup-last6" className="block text-sm text-stellar-muted mb-1">{t("onboarding.keyLast6", "Type the last 6 characters of your secret key to confirm you saved it")}</label>
              <input id="backup-last6" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} className={inputClass} />
            </div>
            <button type="button" disabled={!matches || saving} onClick={confirm} className={btnPrimary}>{t("onboarding.keySaved", "I saved it")}</button>
          </div>
        )}
      </div>
    </main>
  );
}
