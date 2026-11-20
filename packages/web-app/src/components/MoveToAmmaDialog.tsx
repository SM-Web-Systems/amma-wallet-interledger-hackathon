import { useEffect, useId, useRef, useState } from "react";
import { importDeviceWallet, safeToRemoveLocalCopy, type ImportChain } from "../lib/custody-import";
import { moveToAmmaNote } from "../lib/custody-network";
import { useWalletStore } from "../store/wallet";

export interface MoveToAmmaProps {
  chain: ImportChain;
  address: string;
  name: string;
  /** Opens this device's encrypted copy with the device passphrase and returns the secret. Throws a plain-English Error. */
  reveal: (passphrase: string) => Promise<string>;
  /** Deletes this device's copy. Offered only after the server verified the move. */
  removeLocal: () => Promise<void>;
  /** Extra plain-English warning shown before the device copy is deleted. */
  removeWarning?: string;
  onClose: () => void;
}

type Done = "moved" | "already" | "unverified" | "removed";

/**
 * "Move to Amma": device passphrase, Amma password, confirm. The secret lives only inside one submit call.
 * Clearing a string variable is best-effort in JavaScript (copies may linger until garbage collection);
 * the point is that the secret is never kept in state, props or the DOM.
 */
export function MoveToAmmaDialog({ chain, address, name, reveal, removeLocal, removeWarning, onClose }: MoveToAmmaProps) {
  const id = useId();
  const stellarNetwork = useWalletStore((s) => s.network);
  const [devicePass, setDevicePass] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const status = useRef<HTMLDivElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => { if (done) status.current?.focus(); }, [done]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (working) return;
    setWorking(true); setError("");
    let secret = "";
    try {
      secret = await reveal(devicePass);
      const result = await importDeviceWallet({ chain, address, secret, password, name });
      setDone(!safeToRemoveLocalCopy(result, chain, address) ? "unverified" : result.alreadyHeld ? "already" : "moved");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "That did not work. Try again.");
    } finally {
      secret = ""; setDevicePass(""); setPassword(""); setWorking(false);
    }
  };
  const remove = async () => {
    setWorking(true); setError("");
    try { await removeLocal(); setDone("removed"); }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : "The copy on this device could not be removed."); setConfirmRemove(false); }
    finally { setWorking(false); }
  };

  const canRemove = done === "moved" || done === "already";
  return (
    <div role="region" aria-labelledby={`${id}-t`} className="mt-2 space-y-3 rounded-lg border border-stellar-border bg-stellar-dark p-3" onKeyDown={(e) => { if (e.key === "Escape" && !working) onClose(); }}>
      <h3 id={`${id}-t`} className="font-medium">Move {name} to Amma</h3>
      {!done ? (
        <form className="space-y-3" onSubmit={(e) => void submit(e)} autoComplete="off">
          <p className="text-sm text-stellar-muted">Amma will keep an encrypted copy of this wallet's key so it can sign for you and you can use it on any device. {moveToAmmaNote(chain, stellarNetwork)}</p>
          <label className="block text-sm">Device passphrase
            <input ref={first} className="ui-field min-h-[44px]" type="password" autoComplete="off" maxLength={128} value={devicePass} onChange={(e) => setDevicePass(e.target.value)} />
          </label>
          <label className="block text-sm">Your Amma password
            <input className="ui-field min-h-[44px]" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p role="alert" className="ui-alert-error">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button className="ui-btn-primary min-h-[44px] px-3 text-sm" disabled={working || !devicePass || !password}>{working ? "Moving…" : "Move to Amma"}</button>
            <button type="button" className="ui-btn-secondary min-h-[44px] px-3 text-sm" disabled={working} onClick={onClose}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <div ref={status} tabIndex={-1} role="status" className="ui-alert-ok">
            {done === "removed" ? "The copy on this device is removed. Amma now holds this wallet."
              : done === "already" ? "Amma already holds this wallet."
              : done === "unverified" ? "Amma stored the wallet but couldn't verify it yet. Keep the copy on your device."
              : "Done. Amma now holds this wallet and can sign for it."}
          </div>
          {error && <p role="alert" className="ui-alert-error">{error}</p>}
          {canRemove && !confirmRemove && <>
            <p className="text-sm text-stellar-muted">You can keep the copy on this device or remove it. Amma cannot give the key back to you yet, so keep your own written backup before removing it.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="ui-btn-secondary min-h-[44px] px-3 text-sm" disabled={working} onClick={() => setConfirmRemove(true)}>Remove the copy on this device</button>
              <button type="button" className="ui-btn-ghost min-h-[44px] px-3 text-sm" onClick={onClose}>Keep it</button>
            </div>
          </>}
          {canRemove && confirmRemove && <>
            <p role="alert" className="ui-alert-warn">{removeWarning ?? "This deletes the encrypted key from this device."} This cannot be undone.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="ui-btn-primary min-h-[44px] px-3 text-sm" disabled={working} onClick={() => void remove()}>Yes, delete the copy on this device</button>
              <button type="button" className="ui-btn-ghost min-h-[44px] px-3 text-sm" disabled={working} onClick={() => setConfirmRemove(false)}>Keep it</button>
            </div>
          </>}
          {!canRemove && <button type="button" className="ui-btn-ghost min-h-[44px] px-3 text-sm" onClick={onClose}>Close</button>}
        </div>
      )}
    </div>
  );
}
