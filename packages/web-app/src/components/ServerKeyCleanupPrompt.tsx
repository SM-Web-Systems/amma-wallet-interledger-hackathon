import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";

/**
 * Audit F-1 / TODO D1b. Wallets created before self-custody keys stayed on the
 * device left an encrypted copy on Amma's server. After an unlock proves this
 * device holds the key, offer to delete that copy. The person decides.
 */
export default function ServerKeyCleanupPrompt() {
  const account = useWalletStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const unlocked = useWalletStore((s) => s.isUnlocked);
  const upgradePending = useWalletStore((s) => s.needsPassphraseUpgrade);
  const removeServerKeyCopy = useWalletStore((s) => s.removeServerKeyCopy);
  const selfCustody = useAuthStore((s) => s.signingMode === "self");
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!account?.hasServerKey || !selfCustody || !unlocked || upgradePending || dismissed === account.id) return null;

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await removeServerKeyCopy();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The server copy could not be removed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section role="region" aria-labelledby="server-key-title" className="ui-card mb-4 space-y-3 p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={18} className="text-stellar-link" aria-hidden />
        <h2 id="server-key-title" className="font-semibold text-stellar-text">Remove the copy of this key from Amma's server?</h2>
      </div>
      <p className="text-sm text-stellar-muted">
        Amma's server still holds an encrypted copy of "{account.name}"'s key from an older version of the app. In self-custody
        mode the key only needs to be on your device. Before you remove it, make sure you have this wallet's recovery
        phrase or secret key: without it, a lost device means a lost wallet.
      </p>
      {error && <p role="alert" className="ui-alert-error">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-btn-primary" disabled={busy} onClick={() => void remove()}>{busy ? "Removing…" : "Remove server copy"}</button>
        <button type="button" className="ui-btn-ghost" disabled={busy} onClick={() => setDismissed(account.id)}>Not now</button>
      </div>
    </section>
  );
}
