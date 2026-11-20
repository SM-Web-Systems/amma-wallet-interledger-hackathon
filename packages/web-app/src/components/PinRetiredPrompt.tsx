import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";
import { moveLegacyPinWallet, openWithPin, SENDING_PAUSED_MESSAGE } from "../lib/pin-retire";

type Done = "moved" | "paused";

/**
 * Shown after a wallet is opened with an old short PIN, or when the server refuses a PIN signature.
 * PINs are retired: the wallet moves into the person's Amma account and the login password signs from then on.
 * There is no option to keep the PIN or set a passphrase instead. Where Amma can't hold the wallet yet, sending is paused.
 */
export default function PinRetiredPrompt() {
  const needed = useWalletStore((s) => s.needsPassphraseUpgrade);
  const account = useWalletStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const unlockedSecret = useWalletStore((s) => (s.isUnlocked ? s._mnemonic ?? s._secretKey : null));
  const removeLocalKey = useWalletStore((s) => s.removeLocalKey);
  const selfCustody = useAuthStore((s) => s.signingMode === "self");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done>();

  if (!account || (!needed && !done)) return null;
  const close = () => { setDone(undefined); useWalletStore.setState({ needsPassphraseUpgrade: false }); };

  const move = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!unlockedSecret && !pin) return setError("Enter your wallet passphrase.");
    if (!password) return setError("Enter your Amma login password.");
    setBusy(true);
    setError("");
    let secret = "";
    try {
      secret = unlockedSecret ?? (await openWithPin(account, pin));
      const outcome = await moveLegacyPinWallet({ address: account.publicKey, secret, password, selfCustody, name: account.name });
      if (outcome === "moved") {
        // The PIN-encrypted copy on this device goes too; the server already deleted its own after verifying.
        await removeLocalKey(account.id, account.publicKey).catch(() => undefined);
        if (selfCustody) useAuthStore.setState({ signingMode: "delegated" });
        useWalletStore.setState({ isUnlocked: false, _secretKey: null, _mnemonic: null });
      }
      setDone(outcome);
      useWalletStore.setState({ needsPassphraseUpgrade: false });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The wallet could not be moved. Nothing was changed.");
    } finally {
      secret = "";
      setPin("");
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="pin-retired-title" className="ui-card w-full max-w-md space-y-4 p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} className="text-stellar-link" aria-hidden />
          <h2 id="pin-retired-title" className="text-lg font-semibold text-stellar-text">Move this wallet to your Amma account</h2>
        </div>
        {done === "moved" ? (
          <>
            <p role="status" className="ui-alert-ok">Done. {account.name} is now held by your Amma account. Use your Amma login password to send from now on.</p>
            <button type="button" className="ui-btn-primary w-full" onClick={close}>OK</button>
          </>
        ) : done === "paused" ? (
          <>
            <p role="status" className="ui-alert-warn">{SENDING_PAUSED_MESSAGE}</p>
            <button type="button" className="ui-btn-primary w-full" onClick={close}>OK</button>
          </>
        ) : (
          <form className="space-y-4" onSubmit={(e) => void move(e)} autoComplete="off">
            <p className="text-sm text-stellar-muted">
              Short wallet passphrases are no longer used because they are too easy to guess. Amma will hold {account.name} for
              your account, and you'll send with your Amma login password from now on.
            </p>
            {!unlockedSecret && (
              <div>
                <label htmlFor="retire-pin" className="ui-label">Wallet passphrase</label>
                <input id="retire-pin" type="password" autoComplete="off" maxLength={128} className="ui-field" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
              </div>
            )}
            <div>
              <label htmlFor="retire-password" className="ui-label">Amma login password</label>
              <input id="retire-password" type="password" autoComplete="current-password" maxLength={256} className="ui-field" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!unlockedSecret} />
            </div>
            {error && <p role="alert" className="text-sm text-stellar-danger-text">{error}</p>}
            <div className="flex gap-3">
              <button type="button" className="ui-btn-ghost flex-1" disabled={busy} onClick={close}>Not now</button>
              <button type="submit" className="ui-btn-primary flex-1" disabled={busy}>{busy ? "Moving…" : "Move wallet"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
