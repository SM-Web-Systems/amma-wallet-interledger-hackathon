import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "lucide-react";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";
import { signingApi, keyEscrowApi } from "../lib/api";
import { loadStellarSecret } from "../lib/stellar-keystore";
import PinModal from "./PinModal";

/**
 * Wallet backup and recovery. Amma keeps an encrypted backup of the wallet's key by default (delegated
 * signing), so a lost browser or phone does not lose the wallet. Turning it off means the user keeps
 * their own keys. When this browser has no key for the wallet, it can be restored from that backup.
 * The app has the same section with the same wording.
 */
export default function WalletBackupCard() {
  const { t } = useTranslation();
  const signingMode = useAuthStore((s) => s.signingMode);
  const active = useWalletStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const [busy, setBusy] = useState(false);
  const [hasKeyHere, setHasKeyHere] = useState<boolean | null>(null);
  const [askPassphrase, setAskPassphrase] = useState(false);
  // Amma's sealed backup of the one recovery phrase: null until known or when the server has it switched off.
  const [phraseBackup, setPhraseBackup] = useState<"saved" | "missing" | null>(null);
  const getMnemonic = useWalletStore((s) => s.getMnemonic);

  const publicKey = active?.publicKey;
  const localCopy = active?.encryptedSecret;
  useEffect(() => {
    let live = true;
    if (!publicKey) {
      setHasKeyHere(null);
      return;
    }
    if (localCopy) {
      setHasKeyHere(true);
      return;
    }
    loadStellarSecret(publicKey)
      .then((c) => live && setHasKeyHere(Boolean(c)))
      .catch(() => live && setHasKeyHere(null));
    return () => {
      live = false;
    };
  }, [publicKey, localCopy]);

  useEffect(() => {
    let live = true;
    keyEscrowApi
      .status()
      .then((st) => live && setPhraseBackup(!st.enabled ? null : st.hasPhrase ? "saved" : "missing"))
      .catch(() => live && setPhraseBackup(null));
    return () => {
      live = false;
    };
  }, [signingMode]);

  if (!active) return null;
  const backupOn = signingMode === "delegated";
  const heldPhrase = getMnemonic?.() ?? null;

  const backUpPhrase = async () => {
    if (!heldPhrase) return;
    setBusy(true);
    try {
      const result = await useWalletStore.getState().backupRecoveryPhrase(heldPhrase);
      if (result === "saved") {
        setPhraseBackup("saved");
        toast.success(t("settings.phraseBackedUp", "Amma now keeps a sealed backup of your recovery phrase"));
      } else {
        toast.error(t("settings.phraseBackupFailed", "The recovery phrase could not be backed up. Try again in a moment."));
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    const next = backupOn ? "self" : "delegated";
    const message = backupOn
      ? t(
          "settings.backupOffWarning",
          "Amma will stop keeping a backup, and the copy it holds is removed. If you lose this browser or phone, only your recovery phrase or secret key can get the wallet back. Make sure you have saved it. Continue?"
        )
      : t(
          "settings.backupOnWarning",
          "Amma will keep an encrypted copy of your key so you can restore the wallet on a new device and Amma can sign for you. The copy opens only with your wallet passphrase. Continue?"
        );
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      // Backup on needs this browser's encrypted copy first (D1); backup off leaves removal of Amma's copy to the prompt after unlock.
      if (next === "delegated") await useWalletStore.getState().uploadKeysForDelegatedSigning();
      await signingApi.setMode(next);
      useAuthStore.setState({ signingMode: next });
      toast.success(
        next === "delegated"
          ? t("settings.backupOnDone", "Amma now keeps an encrypted backup of your keys")
          : t("settings.backupOffDone", "You now keep your own keys")
      );
    } catch (err) {
      toast.error((err as Error)?.message || t("settings.signingModeError", "Failed to update signing mode"));
    } finally {
      setBusy(false);
    }
  };

  const missingHere = hasKeyHere === false;
  return (
    <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-4">
      <h2 className="text-sm font-semibold text-stellar-muted uppercase tracking-wider flex items-center gap-2">
        <ShieldCheck size={16} />
        {t("settings.backupTitle", "Wallet backup and recovery")}
      </h2>

      <div className="flex items-start gap-4">
        <div className="flex-1 space-y-1">
          <p id="backup-label" className="text-sm text-stellar-text">
            {t("settings.backupSwitch", "Amma keeps an encrypted backup of my keys")}
          </p>
          <p className="text-xs text-stellar-muted">
            {backupOn
              ? t("settings.backupOnDesc", "On. If you lose this device you can restore the wallet from your Amma account with your wallet passphrase.")
              : t("settings.backupOffDesc", "Off. You keep your own keys. If you lose this device, only your recovery phrase or secret key can restore the wallet.")}
          </p>
        </div>
        {busy ? (
          <Loader2 size={18} className="animate-spin text-stellar-muted mt-1" />
        ) : (
          <button
            type="button"
            role="switch"
            aria-checked={backupOn}
            aria-labelledby="backup-label"
            onClick={toggle}
            className={`relative inline-flex min-h-0 h-6 w-11 shrink-0 items-center rounded-full transition-colors ${backupOn ? "bg-stellar-blue" : "bg-stellar-border"}`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${backupOn ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        )}
      </div>

      {backupOn && phraseBackup && (
        <div className="space-y-2">
          <p className="text-xs text-stellar-muted">
            {phraseBackup === "saved"
              ? t("settings.phraseBackupSaved", "Amma has a sealed backup of your recovery phrase, so every wallet made from it can be restored.")
              : heldPhrase
                ? t("settings.phraseBackupMissing", "Your recovery phrase is not backed up yet.")
                : t("settings.phraseBackupMissingHere", "Your recovery phrase is not backed up yet. Create or import a wallet from a recovery phrase to back it up.")}
          </p>
          {phraseBackup === "missing" && heldPhrase && (
            <button type="button" className="ui-btn-secondary py-2" disabled={busy} onClick={backUpPhrase}>
              {t("settings.backUpPhrase", "Back up my recovery phrase")}
            </button>
          )}
        </div>
      )}

      {missingHere && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2">
          <p className="text-sm text-stellar-text">
            {t("settings.keysMissingHere", "This wallet's key is not stored in this browser")}
          </p>
          {active.hasServerKey ? (
            <>
              <p className="text-xs text-stellar-muted">
                {t("settings.keysMissingBackupHint", "Amma holds a backup. Restore it here with the passphrase the wallet was created with, or use your recovery phrase or secret key.")}
              </p>
              <button type="button" className="ui-btn-secondary py-2" onClick={() => setAskPassphrase(true)}>
                {t("settings.restoreFromBackup", "Restore from Amma backup")}
              </button>
            </>
          ) : (
            <p className="text-xs text-stellar-muted">
              {t("settings.keysMissingNoBackup", "Amma has no backup of this wallet. Restore it with your recovery phrase or secret key.")}
            </p>
          )}
        </div>
      )}

      {askPassphrase && (
        <PinModal
          title={t("settings.backupPassphraseTitle", "Passphrase this wallet was created with")}
          onCancel={() => setAskPassphrase(false)}
          onSubmit={async (passphrase) => {
            await useWalletStore.getState().restoreFromServerBackup(passphrase);
            setAskPassphrase(false);
            setHasKeyHere(true);
            toast.success(t("settings.restoredBackup", "The wallet's key is now stored in this browser"));
          }}
        />
      )}
    </div>
  );
}
