import { useState } from "react";
import { useWalletStore } from "../store/wallet";
import { MOVED_MESSAGE, SENDING_PAUSED_MESSAGE } from "../lib/pin-retire";

/**
 * Shown after a wallet is opened with a retired short passphrase. The wallet moves into the person's Amma account
 * with the login password; there is no option to keep the short passphrase or set a new one instead.
 */
export default function PinRetiredDialog() {
  const needed = useWalletStore((s) => s.pinRetired);
  const account = useWalletStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const retire = useWalletStore((s) => s.retireLegacyPin);
  const dismiss = useWalletStore((s) => s.dismissPinRetired);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"moved" | "paused">();

  if (!account || (!needed && !done)) return null;
  const close = () => { setDone(undefined); dismiss(); };

  const move = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!pin) return setError("Enter your wallet passphrase.");
    if (!password) return setError("Enter your Amma login password.");
    setBusy(true);
    setError("");
    try {
      setDone(await retire(pin, password));
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "The wallet could not be moved. Nothing was changed.");
    } finally {
      setPin("");
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="pin-retired-title" className="bg-stellar-card border border-stellar-border rounded-2xl p-6 w-full space-y-4">
        <h2 id="pin-retired-title" className="text-lg font-semibold text-stellar-text">Move this wallet to your Amma account</h2>
        {done ? (
          <>
            <p role="status" className="text-sm text-stellar-text">{done === "moved" ? MOVED_MESSAGE : SENDING_PAUSED_MESSAGE}</p>
            <button type="button" className="w-full py-2 rounded-lg bg-stellar-blue text-white" onClick={close}>OK</button>
          </>
        ) : (
          <form className="space-y-3" onSubmit={(e) => void move(e)} autoComplete="off">
            <p className="text-sm text-stellar-muted">
              Short wallet passphrases are no longer used because they are too easy to guess. Amma will hold {account.name} for
              your account, and you'll send with your Amma login password from now on.
            </p>
            <label className="block text-sm text-stellar-text">Wallet passphrase
              <input type="password" autoComplete="off" maxLength={128} className="mt-1 w-full rounded-lg bg-stellar-bg border border-stellar-border px-3 py-2" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
            </label>
            <label className="block text-sm text-stellar-text">Amma login password
              <input type="password" autoComplete="current-password" maxLength={256} className="mt-1 w-full rounded-lg bg-stellar-bg border border-stellar-border px-3 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <p role="alert" className="text-sm text-stellar-danger">{error}</p>}
            <div className="flex gap-2">
              <button type="button" className="flex-1 py-2 rounded-lg border border-stellar-border text-stellar-text" disabled={busy} onClick={close}>Not now</button>
              <button type="submit" className="flex-1 py-2 rounded-lg bg-stellar-blue text-white disabled:opacity-50" disabled={busy}>{busy ? "Moving…" : "Move wallet"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
