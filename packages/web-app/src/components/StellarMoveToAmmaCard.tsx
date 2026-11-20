import { useEffect, useState } from "react";
import { useWalletStore } from "../store/wallet";
import { revealStellarSecret } from "../lib/stellar-device";
import { loadStellarSecret } from "../lib/stellar-keystore";
import { listCustodyWallets } from "../lib/custody-wallets";
import { MoveToAmmaDialog } from "./MoveToAmmaDialog";
import { custodyNetworkOk, moveToAmmaNote } from "../lib/custody-network";

interface Target { id: string; publicKey: string; name: string; encryptedSecret: string; isHD?: boolean }

/** Settings card: move the active Stellar wallet's device-only key to Amma. Testnet (or the public network in a VITE_MAINNET_CUSTODY=on build), custody on, and a key on this device only. */
export default function StellarMoveToAmmaCard() {
  const active = useWalletStore((s) => s.accounts.find((a) => a.id === s.activeAccountId));
  const network = useWalletStore((s) => s.network);
  const [custodyOn, setCustodyOn] = useState(false);
  // The public key a browser-keystore copy was found for; compared, never reset, so no effect sets state synchronously.
  const [keystoreFor, setKeystoreFor] = useState<string>();

  useEffect(() => {
    let live = true;
    listCustodyWallets().then(() => live && setCustodyOn(true)).catch(() => live && setCustodyOn(false));
    return () => { live = false; };
  }, []);
  const localCopy = active?.encryptedSecret;
  const publicKey = active?.publicKey;
  useEffect(() => {
    let live = true;
    if (!publicKey || localCopy) return;
    loadStellarSecret(publicKey).then((c) => live && setKeystoreFor(c ? publicKey : undefined)).catch(() => undefined);
    return () => { live = false; };
  }, [publicKey, localCopy]);

  if (!active) return null;
  const hasKey = !!localCopy || keystoreFor === active.publicKey;
  // Keyed by account: switching accounts drops an open dialog, so a move or removal can never retarget.
  return <Inner key={active.id} active={active} available={custodyNetworkOk(network) && custodyOn && hasKey} />;
}

function Inner({ active, available }: { active: Target; available: boolean }) {
  const network = useWalletStore((s) => s.network);
  const removeLocalKey = useWalletStore((s) => s.removeLocalKey);
  // Captured at click time.
  const [target, setTarget] = useState<Target>();
  if (!available && !target) return null;
  return (
    <section aria-label="Keep this wallet safe with Amma" className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-3">
      <h2 className="text-sm font-semibold text-stellar-muted uppercase tracking-wider">Keep this wallet safe with Amma</h2>
      <p className="text-xs text-stellar-muted">This wallet's key is on this device only. Move it to Amma and Amma holds an encrypted copy, so it can sign for you. {moveToAmmaNote("stellar", network)}</p>
      {!target && <button type="button" className="ui-btn-secondary min-h-[44px] px-3 text-sm" aria-label={`Move ${active.name} to Amma`}
        onClick={() => setTarget({ id: active.id, publicKey: active.publicKey, name: active.name, encryptedSecret: active.encryptedSecret, isHD: active.isHD })}>Move to Amma</button>}
      {target && <MoveToAmmaDialog chain="stellar" address={target.publicKey} name={target.name}
        reveal={(p) => revealStellarSecret(target, p)}
        removeLocal={() => removeLocalKey(target.id, target.publicKey)}
        removeWarning="This deletes this wallet's key, and its recovery phrase if this device has one, from this device."
        onClose={() => setTarget(undefined)} />}
    </section>
  );
}
