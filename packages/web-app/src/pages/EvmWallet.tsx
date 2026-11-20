import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthStore } from "../store/auth";
import {
  NETWORKS, cancelIntentFor, classify, formatUnits, isFinal, normalizeAddress, parsePositiveUnits, prepareCancel, prepareNativeTransfer, EvmError,
  type AccountSnapshot, type CancelIntent, type PreparedCancel, type PreparedTransfer, type TransferIntent,
} from "@amma-wallet/evm-core";
import { createRecoveryPhrase, listEvmWallets, removeEvmWallet, revealEvmMnemonic, saveEvmWallet, signApprovedEvmCancel, signApprovedEvmTransfer, type LocalEvmWallet } from "../lib/evm/vault";
import { CustodyWalletCards, DeviceWalletCards } from "../components/CustodyWalletCards";
import { CustodySendForm } from "../components/CustodySendForm";
import { listCustodyWallets } from "../lib/custody-wallets";
import { useCustodyWallets } from "../lib/use-custody-wallets";
import { custodyReader, sepoliaReader } from "../lib/evm/client";
import { EvmServerData } from "../components/EvmServerData";
import { formatTokenBalance, getEvmBalances, useEvmServerConfig } from "../lib/eth-server-data";
import { evmCustodyName, evmCustodyReal, evmSymbol, mainnetCustodyBuild } from "../lib/custody-network";
import { explain } from "../lib/evm/messages";
import { listTransfers, mayRebroadcast, nonceForNewTransfer, openTransfers, recordCancel, recordSigned, updateState, type TrackedTransfer } from "../lib/evm/transfers";

const SEPOLIA = NETWORKS["ethereum-sepolia"];

export default function EvmWalletPage() {
  const user = useAuthStore((s) => s.user);
  const ownerId = String(user!.id);
  const reader = useMemo(() => sepoliaReader(), []);
  // Amma-held wallets are read from the network they live on (Ethereum mainnet in a mainnet custody build); device wallets stay on Sepolia.
  const custodyRead = useMemo(() => custodyReader(), []);
  // When Amma's server serves Ethereum data (ETH_SERVER_DATA on), Amma-held wallets are read through it and no browser RPC is used for them.
  const server = useEvmServerConfig();
  const serverOn = server.status === "on";
  const serverPending = server.status === "loading";
  const [wallets, setWallets] = useState<LocalEvmWallet[]>([]);
  const [selected, setSelected] = useState<LocalEvmWallet>();
  const custody = useCustodyWallets("evm");
  const [custodyAddr, setCustodyAddr] = useState<string>();
  const [custodyBalances, setCustodyBalances] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [phrase, setPhrase] = useState(""); const [shownAddress, setShownAddress] = useState("");
  const [confirmation, setConfirmation] = useState(""); const [acknowledged, setAcknowledged] = useState(false);
  const [name, setName] = useState("Sepolia wallet"); const [passphrase, setPassphrase] = useState("");
  const [snapshot, setSnapshot] = useState<AccountSnapshot>();
  const [to, setTo] = useState(""); const [amount, setAmount] = useState("");
  const [review, setReview] = useState<{ intent: TransferIntent; prepared: PreparedTransfer }>();
  const [signPassphrase, setSignPassphrase] = useState("");
  const [transfers, setTransfers] = useState<TrackedTransfer[]>([]);
  const [cancelReview, setCancelReview] = useState<{ original: TrackedTransfer; intent: CancelIntent; prepared: PreparedCancel }>();
  // Count running jobs: several start on mount, and the first to finish must not clear "busy".
  const [pending, setPending] = useState(0); const busy = pending > 0; const [error, setError] = useState("");

  // `real`: the work reads an Amma-held wallet on Ethereum mainnet, so errors must not say Sepolia.
  const run = useCallback(async (work: () => Promise<void>, real = false) => {
    setPending((n) => n + 1); setError("");
    try { await work(); } catch (cause) { setError(explain(cause, real)); } finally { setPending((n) => n - 1); }
  }, []);

  useEffect(() => { void run(async () => { const list = await listEvmWallets(ownerId); setWallets(list); setSelected(list[0]); }); }, [ownerId, run]);
  // A device wallet that Amma now holds is hidden from the device list: do not leave it selected.
  useEffect(() => {
    if (custody.status !== "on" || !selected) return;
    const held = (a: string) => custody.wallets.some((c) => c.address.toLowerCase() === a.toLowerCase());
    if (held(selected.address)) setSelected(wallets.find((w) => !held(w.address)));
  }, [custody.status, custody.wallets, selected, wallets]);
  const viewAddress = custodyAddr || selected?.address;
  // Network words: the network the server reports for the wallet wins over the build flag only to warn (see evmCustodyReal).
  const ammaWallets = custody.status === "on" ? custody.wallets : [];
  const ammaReal = !!custodyAddr && evmCustodyReal(ammaWallets.find((w) => w.address === custodyAddr)?.network ?? (serverOn ? server.config?.network : undefined));
  const pageReal = evmCustodyReal(ammaWallets.some((w) => w.network === "ethereum") ? "ethereum" : undefined);
  const viewReader = custodyAddr ? (serverOn || serverPending ? null : custodyRead) : reader;
  const refresh = useCallback(() => run(async () => { if (viewReader && viewAddress) setSnapshot(await viewReader.account(viewAddress as `0x${string}`)); }, ammaReal), [viewReader, viewAddress, run, ammaReal]);
  // Start on the main Amma wallet; a stale choice (wallet gone) falls back to it too.
  useEffect(() => {
    if (custody.status !== "on") return;
    setCustodyAddr((cur) => (cur && custody.wallets.some((w) => w.address === cur) ? cur : cur === "" ? cur : (custody.wallets.find((w) => w.active) ?? custody.wallets[0])?.address));
  }, [custody.status, custody.wallets]);
  useEffect(() => {
    if (custody.status !== "on" || serverPending) return;
    let live = true;
    if (serverOn) {
      void Promise.all(custody.wallets.map(async (w) => { const b = await getEvmBalances(w.address); return [w.address, `${formatTokenBalance(b.wei, 18)} ${evmSymbol(evmCustodyReal(b.network ?? w.network))}`] as const; }))
        .then((pairs) => { if (live) setCustodyBalances(Object.fromEntries(pairs)); }).catch(() => undefined);
      return () => { live = false; };
    }
    if (!custodyRead) return;
    void Promise.all(custody.wallets.map(async (w) => [w.address, `${formatUnits((await custodyRead.account(w.address as `0x${string}`)).balanceWei, 18)} ${evmSymbol(evmCustodyReal(w.network))}`] as const))
      .then((pairs) => { if (live) setCustodyBalances(Object.fromEntries(pairs)); }).catch(() => undefined);
    return () => { live = false; };
  }, [custodyRead, custody.status, custody.wallets, serverOn, serverPending]);
  useEffect(() => { setSnapshot(undefined); }, [viewAddress]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Resume this wallet's transfers after a reload: some may still be in flight.
  const reload = useCallback(async () => { if (selected) setTransfers(await listTransfers(ownerId, selected.address)); }, [ownerId, selected]);
  useEffect(() => { setTransfers([]); void run(reload); }, [reload, run]);
  const unresolved = openTransfers(transfers);

  // Track every unresolved transfer: rebroadcast the same bytes while unknown, never re-sign.
  useEffect(() => {
    if (!unresolved.length || !reader || !selected) return;
    const timer = setInterval(async () => {
      try {
        const account = await reader.account(selected.address);
        const all = await listTransfers(ownerId, selected.address);
        for (const record of openTransfers(all)) {
          const [tx, receipt] = await Promise.all([reader.transaction(record.hash), reader.receipt(record.hash)]);
          const state = classify(record.nonce, SEPOLIA.confirmations, { transaction: tx, receipt, minedNonce: account.minedNonce, latestBlock: account.blockNumber });
          if (state === "unknown" && mayRebroadcast(record, all)) await reader.broadcast(record.raw, record.hash).catch(() => undefined);
          await updateState(record, state === "unknown" ? "broadcast" : state);
        }
        setTransfers(await listTransfers(ownerId, selected.address));
        if (!custodyAddr) setSnapshot(account);
      } catch { /* keep the last known state; the next tick retries */ }
    }, 6000);
    return () => clearInterval(timer);
  }, [unresolved.length, reader, selected, ownerId, custodyAddr]);

  const startCreate = (wordCount: 12 | 24) => { const fresh = createRecoveryPhrase(wordCount); setPhrase(fresh.mnemonic); setShownAddress(fresh.address); };
  const save = () => run(async () => {
    const saved = await saveEvmWallet({ ownerId, name, mnemonic: phrase, confirmation: mode === "create" ? confirmation : phrase, passphrase, backupAcknowledged: mode === "create" ? acknowledged : true });
    setWallets(await listEvmWallets(ownerId)); setSelected(saved);
    setPhrase(""); setConfirmation(""); setPassphrase(""); setAcknowledged(false); setShownAddress("");
  });
  const prepare = () => run(async () => {
    if (!reader || !selected) return;
    if (unresolved.length) throw new EvmError("EVM_EARLIER_TRANSFER_UNRESOLVED");
    const intent: TransferIntent = { networkId: "ethereum-sepolia", from: selected.address, to: to.trim(), amount: amount.trim() };
    // Validate locally first, then estimate gas for this exact transfer: a first send to a new address needs far more than 21,000.
    const recipient = normalizeAddress(intent.to), valueWei = parsePositiveUnits(intent.amount, SEPOLIA.nativeAsset.decimals);
    const [account, fees, gasEstimate] = await Promise.all([reader.account(selected.address), reader.fees(), reader.estimateTransferGas(selected.address, recipient, valueWei)]);
    const nonce = await nonceForNewTransfer(ownerId, selected.address, account.pendingNonce);
    setReview({ intent, prepared: prepareNativeTransfer(intent, { nonce, balanceWei: account.balanceWei, ...fees, gasEstimate }) });
  });
  const send = () => run(async () => {
    if (!review || !reader) return;
    const { prepared } = review;
    const signed = await signApprovedEvmTransfer(ownerId, signPassphrase, review.intent, prepared);
    setSignPassphrase("");
    // Persist the signed bytes first: from here on the only recovery is rebroadcasting them.
    const record = await recordSigned({ ownerId, from: prepared.from, to: prepared.to, nonce: prepared.nonce, hash: signed.hash, raw: signed.rawTransaction, amount: prepared.display.amount, symbol: prepared.display.symbol });
    await reload();
    setReview(undefined); setAmount("");
    // A failed broadcast is not a failed transfer: the tracker resolves it.
    await reader.broadcast(signed.rawTransaction, signed.hash).catch(() => undefined);
    await updateState(record, "broadcast", { onlyFrom: ["signed"] });
    await reload();
  });
  // Cancel = same nonce, zero value to self, higher fees. Whichever lands first wins; nothing can pay twice.
  const prepareCancelFor = (original: TrackedTransfer) => run(async () => {
    if (!reader || !selected) return;
    const intent = await cancelIntentFor("ethereum-sepolia", original.from, original.nonce, original.raw);
    const [account, fees] = await Promise.all([reader.account(selected.address), reader.fees()]);
    setCancelReview({ original, intent, prepared: prepareCancel(intent, { balanceWei: account.balanceWei, minedNonce: account.minedNonce, ...fees }) });
  });
  const sendCancel = () => run(async () => {
    if (!cancelReview || !reader) return;
    const { original, intent, prepared } = cancelReview;
    const signed = await signApprovedEvmCancel(ownerId, signPassphrase, intent, prepared);
    setSignPassphrase("");
    const record = await recordCancel(original, { hash: signed.hash, raw: signed.rawTransaction, symbol: prepared.display.symbol });
    setCancelReview(undefined);
    await reload();
    await reader.broadcast(signed.rawTransaction, signed.hash).catch(() => undefined);
    await updateState(record, "broadcast", { onlyFrom: ["signed"] });
    await reload();
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 text-stellar-text" aria-busy={busy}>
      <div>
        <h1 className="text-2xl font-semibold">{pageReal ? "Ethereum" : "Ethereum Sepolia (testnet)"}</h1>
        {pageReal && <p className="text-sm">Amma-held wallets below are on Ethereum mainnet (real ETH). Wallets kept on this device stay on the Sepolia test network.</p>}
        <p className="text-sm text-stellar-muted">{pageReal ? "Wallets on this device use Sepolia. Sepolia ETH has no value. Their keys are encrypted on this device and never sent to Amma." : "Test network only. Sepolia ETH has no value. Keys are encrypted on this device and never sent to Amma."}</p>
        {!reader && <p className="ui-alert-warn mt-2">{pageReal ? "No Sepolia RPC is configured for this build, so wallets on this device cannot show balances or send. Amma-held wallets are not affected." : "No Sepolia RPC is configured for this build, so balances and sending are unavailable."}</p>}
        {mainnetCustodyBuild() && !custodyRead && !serverOn && !serverPending && <p className="ui-alert-warn mt-2">No Ethereum mainnet RPC is configured for this build, so balances of Amma wallets are unavailable.</p>}
      </div>
      {error && <p role="alert" className="ui-alert-error">{error}</p>}

      {custody.status === "on" && (
        <>
          <CustodyWalletCards chain="evm" custody={custody} selected={custodyAddr} balances={custodyBalances} onSelect={setCustodyAddr} />
          <DeviceWalletCards items={wallets.filter((w) => !custody.wallets.some((c) => c.address.toLowerCase() === w.address.toLowerCase()))} selected={custodyAddr ? undefined : selected?.address}
            onSelect={(a) => { setCustodyAddr(""); setSelected(wallets.find((w) => w.address === a)); }}
            move={{
              chain: "evm", has: (a) => wallets.some((w) => w.address === a),
              reveal: async (a, pass) => { try { return await revealEvmMnemonic(ownerId, a, pass); } catch (cause) { throw new Error(explain(cause)); } },
              removeLocal: async (a) => {
                if (!(await listCustodyWallets()).some((c) => c.address.toLowerCase() === a.toLowerCase())) throw new Error("Amma does not list this wallet yet, so the copy on this device was kept.");
                try { await removeEvmWallet(ownerId, a); } catch (cause) { throw new Error(explain(cause)); }
                const list = await listEvmWallets(ownerId); setWallets(list); setSelected((cur) => (cur && list.some((w) => w.address === cur.address) ? cur : list[0]));
              },
            }} />
        </>
      )}

      {(custody.status === "on" ? !!viewAddress : wallets.length > 0) && (
        <section id="receive" aria-label={custodyAddr ? `Receive ${evmCustodyName(ammaReal)}` : "Receive Sepolia ETH"} className="scroll-mt-4 space-y-2">
          {custody.status !== "on" && <>
            <label className="text-sm" htmlFor="evm-wallet">Wallet</label>
            <select id="evm-wallet" className="ui-field" value={selected?.address ?? ""} onChange={(e) => setSelected(wallets.find((w) => w.address === e.target.value))}>
              {wallets.map((w) => <option key={w.address} value={w.address}>{w.name} · {w.address}</option>)}
            </select>
          </>}
          <p data-testid="evm-receive-address" className="break-all font-mono text-sm">{viewAddress}</p>
          {snapshot && <p>Balance: {formatUnits(snapshot.balanceWei, 18)} {(Object.hasOwn(NETWORKS, snapshot.networkId) ? (NETWORKS as Record<string, typeof SEPOLIA>)[snapshot.networkId] : SEPOLIA).nativeAsset.symbol} <span className="text-xs text-stellar-muted">(block {snapshot.blockNumber.toString()}, {snapshot.provider})</span></p>}
          {viewReader && <button className="ui-btn-secondary" disabled={busy} onClick={() => void refresh()}>Refresh</button>}
        </section>
      )}

      {custody.status === "on" && serverOn && !!custodyAddr && <EvmServerData key={`data-${custodyAddr}`} address={custodyAddr} />}

      {custody.status === "on" && !!custodyAddr && <CustodySendForm key={custodyAddr} chain="evm" from={custodyAddr} network={ammaWallets.find((w) => w.address === custodyAddr)?.network ?? (serverOn ? server.config?.network : undefined)} serverPreview={serverOn && server.config?.simulate !== false} />}

      {selected && reader && !custodyAddr && (
        <section id="send" className="ui-card scroll-mt-4 space-y-3 p-5">
          <h2 className="font-semibold">Send Sepolia ETH</h2>
          <input className="ui-field" placeholder="Recipient 0x address" value={to} onChange={(e) => setTo(e.target.value)} />
          <input className="ui-field" placeholder="Amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button className="ui-btn-primary" disabled={busy || !to || !amount} onClick={() => void prepare()}>Review</button>
          {review && (
            <div className="space-y-2 rounded bg-stellar-dark p-3 text-sm">
              <p>To <span className="break-all font-mono">{review.prepared.to}</span></p>
              <p>Amount {review.prepared.display.amount} {review.prepared.display.symbol}</p>
              <p>Maximum network fee {review.prepared.display.maxNetworkFee}</p>
              <p className="font-semibold">Maximum total {review.prepared.display.maxTotal} {review.prepared.display.symbol}</p>
              <input className="ui-field" type="password" placeholder="Vault passphrase" value={signPassphrase} onChange={(e) => setSignPassphrase(e.target.value)} />
              <div className="flex gap-2">
                <button className="ui-btn-primary" disabled={busy || !signPassphrase} onClick={() => void send()}>Approve and send</button>
                <button className="ui-btn-ghost" onClick={() => setReview(undefined)}>Cancel</button>
              </div>
            </div>
          )}
          {transfers.slice(0, 5).map((t) => (
            <div key={t.id} className="text-sm">
              <p>
                {t.kind === "cancel" ? `Cancel of nonce ${t.nonce}` : `Transfer of ${t.amount} ${t.symbol} (nonce ${t.nonce})`}{" "}
                <a className="underline" href={`${SEPOLIA.explorerTxUrl}${t.hash}`} target="_blank" rel="noreferrer noopener">{t.hash.slice(0, 12)}…</a>: {t.state}
              </p>
              {t.kind !== "cancel" && !isFinal(t.state) && !transfers.some((c) => c.kind === "cancel" && c.nonce === t.nonce) && (
                <button className="text-xs underline" disabled={busy} onClick={() => void prepareCancelFor(t)}>Cancel this transfer</button>
              )}
            </div>
          ))}
          {cancelReview && (
            <div className="space-y-2 rounded bg-stellar-dark p-3 text-sm">
              <p>Cancel the transfer with nonce {cancelReview.prepared.nonce} by sending 0 {cancelReview.prepared.display.symbol} to yourself with a higher fee.</p>
              <p>Maximum network fee {cancelReview.prepared.display.maxNetworkFee} {cancelReview.prepared.display.symbol}</p>
              <p className="text-xs text-stellar-muted">If the original transfer is included first, it still goes through and the cancel is dropped.</p>
              <input className="ui-field" type="password" placeholder="Vault passphrase" value={signPassphrase} onChange={(e) => setSignPassphrase(e.target.value)} />
              <div className="flex gap-2">
                <button className="ui-btn-primary" disabled={busy || !signPassphrase} onClick={() => void sendCancel()}>Approve cancel</button>
                <button className="ui-btn-ghost" onClick={() => setCancelReview(undefined)}>Keep waiting</button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="ui-card space-y-3 p-5">
        <h2 className="font-semibold">{wallets.length ? "Add another wallet" : "Set up a Sepolia wallet"}</h2>
        <div role="group" aria-label="Create or restore" className="ui-segment">
          {([["create", "Create"], ["restore", "Restore"]] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={mode === value} className="ui-segment-item" onClick={() => { setMode(value); setPhrase(""); if (value === "restore") setShownAddress(""); }}>{label}</button>
          ))}
        </div>
        {mode === "create" && !phrase && (
          <div className="flex flex-wrap gap-2">
            <button className="ui-btn-secondary" onClick={() => startCreate(12)}>Generate 12-word phrase</button>
            <button className="ui-btn-primary" onClick={() => startCreate(24)}>Generate 24-word phrase</button>
          </div>
        )}
        {mode === "create" && phrase && (
          <>
            <p className="text-sm">Write these {phrase.split(" ").length} words down in order and keep them offline. Anyone with them controls this wallet; Amma cannot recover them.</p>
            <p className="rounded bg-stellar-dark p-3 font-mono text-sm" data-testid="evm-phrase">{phrase}</p>
            <p className="break-all text-xs">Address: {shownAddress}</p>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I have written the phrase down</label>
            <textarea className="ui-field" placeholder="Re-enter the recovery phrase" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
          </>
        )}
        {mode === "restore" && <textarea className="ui-field" placeholder="Recovery phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} />}
        {phrase && (
          <>
            <input className="ui-field" placeholder="Wallet name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="ui-field" type="password" placeholder="Local vault passphrase (12+ characters)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <button className="ui-btn-primary" disabled={busy} onClick={() => void save()}>Encrypt and save on this device</button>
          </>
        )}
      </section>
    </div>
  );
}
