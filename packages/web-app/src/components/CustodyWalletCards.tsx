import { useEffect, useState } from "react";
import { type CustodyChain } from "../lib/custody-wallets";
import { MoveToAmmaDialog } from "./MoveToAmmaDialog";
import { shortAddress, type useCustodyWallets } from "../lib/use-custody-wallets";
import { MAX_WALLETS_PER_CHAIN, XRP_BASE_RESERVE, useAdvancedWallets, walletLimitReached } from "../lib/advanced-wallets";
import { XRP_NOT_ACTIVATED } from "../lib/custody-network";

const cardClass = (on: boolean) => `rounded-lg border p-3 ${on ? "border-stellar-accent bg-stellar-dark" : "border-stellar-border"}`;
const pick = "block min-h-[44px] w-full rounded text-left";
const small = "ui-btn-secondary min-h-[44px] px-3 text-sm";

function CopyButton({ address, label }: { address: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className={small} aria-label={`Copy address of ${label}`} onClick={() => { void navigator.clipboard?.writeText(address).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? "Copied" : "Copy"}</button>;
}

export interface CustodyCardsProps {
  chain: CustodyChain;
  custody: ReturnType<typeof useCustodyWallets>;
  selected: string | undefined;
  onSelect: (address: string) => void;
  /** Formatted balance by address; missing means not known yet. */
  balances: Record<string, string>;
  balanceFallback?: string;
}

export function CustodyWalletCards({ chain, custody, selected, onSelect, balances, balanceFallback = "Balance loading…" }: CustodyCardsProps) {
  const [renaming, setRenaming] = useState<string>();
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [advanced] = useAdvancedWallets();
  const noun = chain === "evm" ? "Ethereum" : "XRP";
  const full = walletLimitReached(custody.wallets.length);
  useEffect(() => { if (!advanced) setConfirming(false); }, [advanced]);
  const startAdd = () => { if (chain === "xrpl") setConfirming(true); else void custody.add(); };
  return (
    <section aria-label={`Your Amma ${noun} wallets`} className="space-y-3">
      <h2 className="font-semibold">Your Amma wallets</h2>
      <ul className="space-y-2">
        {custody.wallets.map((w) => (
          <li key={w.address} className={cardClass(selected === w.address)}>
            <button type="button" aria-pressed={selected === w.address} className={pick} onClick={() => onSelect(w.address)}>
              <span className="font-medium">{w.name}</span>{w.active && <span className="ml-2 rounded bg-stellar-border px-2 py-0.5 text-xs">Main</span>}
              <span className="block break-all font-mono text-xs">{shortAddress(w.address)}</span>
              <span className="block text-sm text-stellar-muted">{balances[w.address] ?? balanceFallback}</span>
            </button>
            {renaming === w.address ? (
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); const next = draft.trim(); if (next) { void custody.rename(w.address, next); setRenaming(undefined); } }}>
                <label className="flex-1 text-sm">New name<input className="ui-field min-h-[44px]" maxLength={40} value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
                <button className="ui-btn-primary min-h-[44px] px-3 text-sm" disabled={!draft.trim() || custody.working}>Save name</button>
                <button type="button" className={small} onClick={() => setRenaming(undefined)}>Cancel</button>
              </form>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton address={w.address} label={w.name} />
                {!w.active && <button type="button" className={small} disabled={custody.working} aria-label={`Make ${w.name} main`} onClick={() => void custody.makeMain(w.address)}>Make main</button>}
                <button type="button" className={small} aria-label={`Rename ${w.name}`} onClick={() => { setRenaming(w.address); setDraft(w.name); }}>Rename</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {advanced ? (
        <>
          {confirming ? (
            <div role="group" aria-label="Before you add an XRP wallet" className="space-y-2 rounded-lg border border-stellar-border p-3 text-sm">
              <p>Once funded, every XRP wallet must hold a reserve (currently {XRP_BASE_RESERVE} XRP) that cannot be spent while the wallet exists. A new wallet starts empty. {XRP_NOT_ACTIVATED}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="ui-btn-primary min-h-[44px] px-3 text-sm" disabled={custody.working || full} onClick={() => { setConfirming(false); void custody.add(); }}>Create wallet</button>
                <button type="button" className={small} onClick={() => setConfirming(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button type="button" className="ui-btn-secondary min-h-[44px]" disabled={custody.working || full} onClick={startAdd}>Add wallet</button>
          )}
          {full && <p className="text-sm text-stellar-muted">You have reached the limit of {MAX_WALLETS_PER_CHAIN} wallets on this network.</p>}
        </>
      ) : (
        <p className="text-sm text-stellar-muted">Need more than one wallet? Turn on Advanced wallets in Settings.</p>
      )}
      {custody.message && <p role="alert" className="ui-alert-warn">{custody.message}</p>}
    </section>
  );
}

export interface DeviceItem { address: string; name: string }
export interface DeviceMove {
  chain: "xrpl" | "evm";
  /** False for wallets with no encrypted copy on this device. */
  has: (address: string) => boolean;
  reveal: (address: string, passphrase: string) => Promise<string>;
  removeLocal: (address: string) => Promise<void>;
}
export function DeviceWalletCards({ items, selected, onSelect, move }: { items: DeviceItem[]; selected: string | undefined; onSelect: (address: string) => void; move?: DeviceMove }) {
  // Kept apart from the list: once the move works the card leaves this list, but "Remove the copy on this device" must stay.
  const [moving, setMoving] = useState<DeviceItem>();
  if (!items.length && !moving) return null;
  return (
    <section aria-label="On this device only" className="space-y-2">
      <h2 className="font-semibold">On this device only</h2>
      <p className="text-sm text-stellar-muted">These keys stay on this device. Amma cannot recover them.</p>
      <ul className="space-y-2">
        {items.map((w) => (
          <li key={w.address} className={cardClass(selected === w.address)}>
            <button type="button" aria-pressed={selected === w.address} className={pick} onClick={() => onSelect(w.address)}>
              <span className="font-medium">{w.name}</span>
              <span className="block break-all font-mono text-xs">{shortAddress(w.address)}</span>
            </button>
            {move?.has(w.address) && <div className="mt-2"><button type="button" className={small} aria-label={`Move ${w.name} to Amma`} disabled={!!moving} onClick={() => setMoving(w)}>Move to Amma</button></div>}
          </li>
        ))}
      </ul>
      {move && moving && <MoveToAmmaDialog key={moving.address} chain={move.chain} address={moving.address} name={moving.name}
        reveal={(p) => move.reveal(moving.address, p)} removeLocal={() => move.removeLocal(moving.address)} onClose={() => setMoving(undefined)} />}
    </section>
  );
}
