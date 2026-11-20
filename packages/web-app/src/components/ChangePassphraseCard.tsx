import { useState } from "react";
import { KeyRound } from "lucide-react";
import { useWalletStore } from "../store/wallet";
import { useAuthStore } from "../store/auth";
import { changePassphraseProblem } from "../lib/passphrase";
import { changeLocalPassphrase, listLocalWallets, VaultError } from "../lib/xrpl/vault";

/**
 * Settings: change the wallet passphrase on this device. Moves every Stellar wallet and every XRP wallet
 * kept in this browser that opens with the current passphrase. Other devices keep their own passphrase.
 */
export default function ChangePassphraseCard() {
  const changeStellar = useWalletStore((s) => s.changePassphrase);
  const hasStellar = useWalletStore((s) => s.accounts.length > 0);
  const userId = useAuthStore((s) => s.user?.id);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => { setCurrent(""); setNext(""); setConfirm(""); setError(""); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDone("");
    const problem = changePassphraseProblem(current, next, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    let changed = 0;
    let skipped = 0;
    try {
      if (hasStellar) {
        try {
          changed += await changeStellar(current, next);
        } catch (err) {
          // A Stellar wallet under another passphrase is not an error here; XRP wallets may still match.
          if (!(err instanceof Error) || !/wrong passphrase/i.test(err.message)) throw err;
        }
      }
      if (userId !== undefined) {
        const wallets = await listLocalWallets(String(userId)).catch(() => []);
        for (const wallet of wallets) {
          try {
            await changeLocalPassphrase(String(userId), wallet.address, current, next);
            changed += 1;
          } catch (err) {
            if (err instanceof VaultError && err.message === "UNLOCK_FAILED") skipped += 1;
            else throw err;
          }
        }
      }
      if (changed === 0) {
        setError("That is not the current passphrase for any wallet on this device.");
        return;
      }
      setDone(
        `Passphrase changed for ${changed} wallet${changed === 1 ? "" : "s"} on this device.` +
          (skipped ? ` ${skipped} XRP wallet${skipped === 1 ? " uses" : "s use"} a different passphrase and ${skipped === 1 ? "was" : "were"} not changed.` : ""),
      );
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the passphrase.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => { setDone(""); if (open) reset(); setOpen(!open); }}
        aria-expanded={open}
        className="flex items-center gap-2 w-full px-4 py-3 rounded-lg border border-stellar-border text-stellar-muted hover:text-stellar-text hover:bg-stellar-hover transition-colors text-sm"
      >
        <KeyRound size={16} aria-hidden />
        Change wallet passphrase
      </button>
      {done && <p role="status" className="text-sm text-stellar-link">{done}</p>}
      {open && (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs text-stellar-muted">
            This changes the passphrase on this device only. Your other devices keep their own. If you have forgotten the current one,
            restore the wallet with its recovery phrase instead.
          </p>
          <div>
            <label htmlFor="cp-current" className="ui-label">Current passphrase</label>
            <input id="cp-current" type="password" autoComplete="current-password" className="ui-field" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} />
          </div>
          <div>
            <label htmlFor="cp-new" className="ui-label">New passphrase</label>
            <input id="cp-new" type="password" autoComplete="new-password" className="ui-field" value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} />
          </div>
          <div>
            <label htmlFor="cp-confirm" className="ui-label">Repeat new passphrase</label>
            <input id="cp-confirm" type="password" autoComplete="new-password" className="ui-field" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
          </div>
          {error && <p role="alert" className="text-sm text-stellar-danger-text">{error}</p>}
          <button type="submit" className="ui-btn-primary w-full" disabled={busy}>{busy ? "Changing…" : "Change passphrase"}</button>
        </form>
      )}
    </div>
  );
}
