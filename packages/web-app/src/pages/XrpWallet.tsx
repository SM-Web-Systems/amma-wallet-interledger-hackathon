import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { useAuthStore } from "../store/auth";
import { xrplWalletApi, type XrpServerWallet, type XrpAccountSnapshot } from "../lib/api";
import { createRecoveryPhrase, createRecoverySeed, listLocalWallets, removeLocalWallet, revealLocalSecret, saveLocalWallet, verifyLocalRecovery, validatePassphrase, VaultError, type LocalWallet } from "../lib/xrpl/vault";
import { XRP_LOCK_EVENT, XRP_PAYMENT_LOCK_EVENT, xrplPaymentsEnabled } from "../lib/xrpl/feature";
import { parseApprovalTarget } from "../lib/xrpl/approval-link";
import XrpPayment from "../components/XrpPayment";
import { CustodyWalletCards, DeviceWalletCards } from "../components/CustodyWalletCards";
import { CustodySendForm } from "../components/CustodySendForm";
import { listCustodyWallets } from "../lib/custody-wallets";
import { useCustodyWallets } from "../lib/use-custody-wallets";
import { getCustodyXrpAccount, type CustodyXrpAccount } from "../lib/custody-send";
import { XRP_NOT_ACTIVATED, xrplMainnetBuild } from "../lib/custody-network";

function message(cause: unknown): string {
  if (!(cause instanceof VaultError)) return "The service is unavailable. Your recovery seed and passphrase stay on this device.";
  const messages: Record<string, string> = {
    WEAK_PASSPHRASE: "Use 12–128 characters, not only digits or spaces. A long, unique multi-word passphrase is recommended.",
    BACKUP_REQUIRED: "Save your recovery phrase or seed offline, acknowledge the backup, and re-enter it exactly.",
    INVALID_SEED: "Enter a valid 12 or 24-word recovery phrase, or an XRPL family seed (starts with s). Stellar secret keys are not supported here.",
    INVALID_NAME: "Choose a wallet name of 1–64 characters.",
    RESTORE_REQUIRED: "No encrypted vault exists on this device. Restore with your recovery seed.",
    CORRUPT_VAULT: "This local vault cannot be verified. Restore with your recovery seed.",
    UNLOCK_FAILED: "The passphrase is incorrect or the vault was changed. You can restore with your recovery seed.",
    STORAGE_UNAVAILABLE: "Encrypted browser storage is unavailable. Check browser permissions and free space before continuing.",
  };
  return messages[cause.message] ?? "Unable to verify this local wallet. Restore from your recovery seed.";
}
function xrp(drops: string) {
  const value = BigInt(drops); return `${value / 1000000n}.${(value % 1000000n).toString().padStart(6, "0")}`;
}

export default function XrpWalletPage() {
  const location=useLocation();
  const approval=useMemo(()=>{try{return {target:parseApprovalTarget(location.search),invalid:false};}catch{return {target:null,invalid:true};}},[location.search]);
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const ownerId = String(user!.id);
  const [server, setServer] = useState<XrpServerWallet[]>([]);
  const [local, setLocal] = useState<LocalWallet[]>([]);
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState<"create" | "restore">("create");
  const [name, setName] = useState("");
  const [seed, setSeed] = useState("");
  const [generatedSeed, setGeneratedSeed] = useState("");
  const [recoveryKind, setRecoveryKind] = useState<12 | 24 | "seed">(24);
  const [generatedAddress, setGeneratedAddress] = useState("");
  const [backupVisible, setBackupVisible] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [balance, setBalance] = useState<XrpAccountSnapshot>();
  const [balanceError, setBalanceError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);
  const custody = useCustodyWallets("xrpl");
  const custodyOn = custody.status === "on";
  const [custodyBalances, setCustodyBalances] = useState<Record<string, string>>({});
  // Mainnet build (VITE_XRPL_MAINNET=on): only Amma-held wallets, read through the custody account route.
  const mainnet = xrplMainnetBuild();
  const [mainnetAccounts, setMainnetAccounts] = useState<Record<string, CustodyXrpAccount>>({});
  const picked = useRef(false);
  const epoch = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);

  const clearSecrets = useCallback(() => {
    setSeed(""); setGeneratedSeed(""); setGeneratedAddress(""); setBackupVisible(false);
    setConfirmation(""); setAcknowledged(false); setPassphrase(""); setConfirmPassphrase(""); setUnlockPassphrase("");
  }, []);
  const lock = useCallback(() => { epoch.current++; clearSecrets(); setVerified(false); setNotice(""); window.dispatchEvent(new Event(XRP_PAYMENT_LOCK_EVENT)); }, [clearSecrets]);
  const current = (version: number) => mounted.current && epoch.current === version && useAuthStore.getState().isAuthenticated && String(useAuthStore.getState().user?.id) === ownerId;

  const refresh = useCallback(async () => {
    const version = epoch.current;
    // Mainnet: no device vaults or self-custody registrations (those are testnet-only on the server).
    if (mainnet) return;
    const [localResult, serverResult] = await Promise.allSettled([listLocalWallets(ownerId), xrplWalletApi.list()]);
    if (!mounted.current || version !== epoch.current) return;
    const locals = localResult.status === "fulfilled" ? localResult.value : [];
    const remotes = serverResult.status === "fulfilled" ? serverResult.value.filter((wallet) => wallet.ownerId === ownerId) : [];
    setLocal(locals); setServer(remotes);
    setSelected((previous) => [...locals, ...remotes].some((wallet) => wallet.address === previous) ? previous : (remotes.find(wallet=>wallet.id===approval.target?.walletId)?.address ?? remotes.find((wallet) => wallet.isActive)?.address ?? locals[0]?.address ?? remotes[0]?.address ?? ""));
    if (localResult.status === "rejected") setError(message(localResult.reason));
    else if (serverResult.status === "rejected") setError("Public wallet metadata is unavailable. Local encrypted wallets can still be recovered; retry Sync when the service returns.");
  }, [ownerId,approval.target?.walletId,mainnet]);

  useEffect(() => {
    mounted.current = true; void refresh();
    let lastActivity = Date.now();
    const activity = () => { lastActivity = Date.now(); };
    const visibility = () => { if (document.hidden) lock(); };
    const storage = (event: StorageEvent) => { if (event.key === "amma-wallet-auth") lock(); };
    const timer = window.setInterval(() => { if (Date.now() - lastActivity >= 5 * 60000) lock(); }, 15000);
    window.addEventListener("pointerdown", activity); window.addEventListener("keydown", activity);
    window.addEventListener(XRP_LOCK_EVENT, lock); window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", visibility);
    return () => { mounted.current = false; epoch.current++; window.clearInterval(timer);
      window.removeEventListener("pointerdown", activity); window.removeEventListener("keydown", activity);
      window.removeEventListener(XRP_LOCK_EVENT, lock); window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", visibility); };
  }, [lock, refresh]);

  const addresses = [...new Set([...local.map((wallet) => wallet.address), ...server.map((wallet) => wallet.address)])];
  const selectedLocal = local.find((wallet) => wallet.address === selected);
  const selectedServer = server.find((wallet) => wallet.address === selected);
  const serverId = selectedServer?.id;
  const custodyAddresses = custody.wallets.map((wallet) => wallet.address);
  const selectedCustody = custodyOn && custodyAddresses.includes(selected);
  // Start on the main Amma wallet once; after that the user's own choice stands.
  useEffect(() => {
    if (!custodyOn || picked.current || !custody.wallets.length) return;
    picked.current = true;
    setSelected((custody.wallets.find((wallet) => wallet.active) ?? custody.wallets[0]).address);
  }, [custodyOn, custody.wallets]);
  // Card balances come from the page's existing lookup, which needs a registered wallet id.
  useEffect(() => {
    if (!custodyOn) return;
    let live = true;
    if (mainnet) {
      custody.wallets.forEach((wallet) => {
        void getCustodyXrpAccount(wallet.address).then((value) => {
          if (!live) return;
          setMainnetAccounts((previous) => ({ ...previous, [wallet.address]: value }));
          setCustodyBalances((previous) => ({ ...previous, [wallet.address]: value.activated ? `${xrp(value.balanceDrops)} XRP` : XRP_NOT_ACTIVATED }));
        }).catch(() => undefined);
      });
      return () => { live = false; };
    }
    custody.wallets.forEach((wallet) => {
      const registered = server.find((item) => item.address === wallet.address);
      if (registered) void xrplWalletApi.account(registered.id).then((value) => { if (live) setCustodyBalances((previous) => ({ ...previous, [wallet.address]: value.funded ? `${xrp(value.balanceDrops)} XRP` : "Not yet funded on Testnet" })); }).catch(() => undefined);
    });
    return () => { live = false; };
  }, [custodyOn, custody.wallets, server, refreshCount, mainnet]);
  useEffect(() => {
    let active = true; setBalance(undefined); setBalanceError("");
    if (serverId) void xrplWalletApi.account(serverId).then((value) => { if (active) setBalance(value); }).catch(() => { if (active) setBalanceError("Balance is unavailable. No zero balance has been assumed."); });
    return () => { active = false; };
  }, [selected, serverId, refreshCount]);

  async function sync(wallet: Pick<LocalWallet, "name" | "address">) {
    const version = epoch.current;
    if (!current(version)) return;
    await xrplWalletApi.register({ name: wallet.name, address: wallet.address });
    if (current(version)) await refresh();
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (pending.current) return;
    if (passphrase !== confirmPassphrase) { setError("The local passphrases do not match."); return; }
    pending.current = true; setBusy(true); setError(""); setNotice("");
    const version = epoch.current;
    try {
      const wallet = await saveLocalWallet({ ownerId, name, seed: mode === "create" ? generatedSeed : seed,
        seedConfirmation: confirmation, passphrase, backupAcknowledged: acknowledged });
      if (!current(version)) return;
      clearSecrets(); setSelected(wallet.address); setVerified(false);
      setNotice("Encrypted wallet saved and recovery checked on this device. Keep your offline seed backup.");
      try { await sync(wallet); } catch { if (current(version)) setError("Your encrypted vault is saved locally. Public metadata registration failed; retry Sync."); }
      if (current(version)) await refresh();
    } catch (cause) { if (current(version)) setError(message(cause)); }
    finally { pending.current = false; if (mounted.current) { clearSecrets(); setBusy(false); } }
  }
  async function verify(event: React.FormEvent) {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); const version = epoch.current;
    try { await verifyLocalRecovery(ownerId, selected, unlockPassphrase); if (current(version)) { setVerified(true); setNotice("Local recovery verified. No private key is kept unlocked between actions."); } }
    catch (cause) { if (current(version)) { setVerified(false); setError(message(cause)); } }
    finally { pending.current = false; if (mounted.current) { setUnlockPassphrase(""); setBusy(false); } }
  }

  return <div className="text-stellar-text">
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm text-stellar-muted">Amma Wallet</p><h1 className="mt-1 text-2xl font-semibold">XRP wallets</h1></div>
        <div className="flex gap-2"><button type="button" className="ui-btn-secondary py-2" onClick={lock}>Lock & clear drafts</button><button type="button" className="ui-btn-ghost py-2" onClick={() => { lock(); void logout(); }}>Sign out</button></div>
      </header>
      {mainnet
        ? <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm">XRP Ledger · Wallets Amma holds for you. Each payment needs your Amma password and has small limits.</p>
        : <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm">XRPL Testnet · Test funds only. {xrplPaymentsEnabled ? "Each payment requires your explicit approval." : "Payments are not enabled."}</p>}
      {mainnet && custody.status === "off" && <p className="text-sm">XRP wallets aren't available for this account yet.</p>}
      {error && <p role="alert" className="ui-alert-error">{error}</p>}
      {notice && <p role="status" className="ui-alert-ok">{notice}</p>}
      {custodyOn && <section aria-label="Amma XRP wallets" className="space-y-4 ui-card p-5">
        <CustodyWalletCards chain="xrpl" custody={custody} selected={selectedCustody ? selected : undefined} balances={custodyBalances} balanceFallback="Balance not available here yet"
          onSelect={(address) => { lock(); setSelected(address); }} />
        {!mainnet && <DeviceWalletCards selected={selectedCustody ? undefined : selected}
          items={addresses.filter((address) => !custodyAddresses.includes(address)).map((address) => ({ address, name: local.find((item) => item.address === address)?.name ?? server.find((item) => item.address === address)?.name ?? "Wallet" }))}
          move={{
            chain: "xrpl", has: (address) => local.some((item) => item.address === address),
            reveal: async (address, pass) => { try { return await revealLocalSecret(ownerId, address, pass); } catch (cause) { throw new Error(message(cause)); } },
            removeLocal: async (address) => { if (!(await listCustodyWallets()).some((c) => c.address === address)) throw new Error("Amma does not list this wallet yet, so the copy on this device was kept."); try { await removeLocalWallet(ownerId, address); } catch (cause) { throw new Error(message(cause)); } await refresh(); },
          }}
          onSelect={(address) => { lock(); setSelected(address); const wallet = server.find((item) => item.address === address); if (wallet) void xrplWalletApi.activate(wallet.id).catch(() => setError("Wallet selection could not be synced. Try again.")); }} />}
      </section>}
      {(custodyOn ? !!selected : addresses.length > 0) && <section aria-label="Your XRP wallets" className="space-y-4 ui-card p-5">
        {!custodyOn && <label className="block space-y-1"><span>Wallet</span><select aria-label="Wallet" className="ui-field" value={selected} onChange={(event) => {
          lock(); const address = event.target.value; setSelected(address);
          const wallet = server.find((item) => item.address === address);
          if (wallet) void xrplWalletApi.activate(wallet.id).catch(() => setError("Wallet selection could not be synced. Try again."));
        }}>{addresses.map((address) => <option key={address} value={address}>{local.find((item) => item.address === address)?.name ?? server.find((item) => item.address === address)?.name} · {address.slice(0, 8)}…</option>)}</select></label>}
        <div className="flex flex-wrap items-start gap-5"><div className="rounded-lg bg-white p-3"><QRCodeSVG value={selected} size={128} /></div><div id="receive" className="min-w-0 flex-1 basis-full scroll-mt-4 space-y-2 sm:basis-0">
          {mainnet ? <>
            <h2 className="font-medium">Receive XRP</h2><p data-testid="receive-address" className="break-all font-mono text-sm">{selected}</p>
            <p className="text-sm text-stellar-muted">Use this address on the XRP Ledger.</p>
            {mainnetAccounts[selected]
              ? mainnetAccounts[selected].activated
                ? <div className="text-sm"><p>Balance: {xrp(mainnetAccounts[selected].balanceDrops)} XRP</p><p>Reserve: {xrp(mainnetAccounts[selected].reserveDrops)} XRP</p><p>Available before transaction fees: {xrp(mainnetAccounts[selected].spendableDrops)} XRP</p></div>
                : <p role="status" className="text-sm">{XRP_NOT_ACTIVATED}</p>
              : <p className="text-sm text-stellar-muted">Balance not available here yet.</p>}
          </> : <>
          <h2 className="font-medium">Receive Testnet XRP</h2><p data-testid="receive-address" className="break-all font-mono text-sm">{selected}</p>
          <p className="text-sm text-stellar-muted">Use this address only on XRPL Testnet.</p>
          <a href="https://xrpl.org/resources/dev-tools/xrp-faucets" target="_blank" rel="noopener noreferrer" className="ui-link text-sm">Open Testnet funding instructions</a>
          {balance ? <div className="text-sm"><p>{balance.funded ? `Balance: ${xrp(balance.balanceDrops)} XRP` : "Account not yet funded on Testnet."}</p><p>Reserve: {xrp(balance.reserveDrops)} XRP</p><p>Available before transaction fees: {xrp(balance.spendableDrops)} XRP</p></div> : <p className="text-sm text-stellar-muted">{balanceError || (selectedCustody ? "Balance is not available for this wallet here yet." : serverId ? "Loading validated balance…" : "Sync public metadata to load the balance.")}</p>}
          </>}
          <button className="ui-link text-sm" type="button" onClick={() => setRefreshCount((count) => count + 1)}>Refresh balance</button>
        </div></div>
        {selectedCustody ? <CustodySendForm key={selected} chain="xrpl" from={selected} /> : <p className="text-sm">{verified ? "Local recovery verified this session." : selectedLocal ? "Local encrypted vault locked." : "Recovery required on this device. Restore with your recovery phrase or seed below."}</p>}
        {selectedLocal && <form onSubmit={(event) => void verify(event)} className="flex flex-wrap items-end gap-3">
          <label className="flex-1 space-y-1"><span className="text-sm">Local vault passphrase</span><input aria-label="Unlock passphrase" type="password" autoComplete="off" maxLength={128} className="ui-field" value={unlockPassphrase} onChange={(event) => setUnlockPassphrase(event.target.value)} /></label>
          <button disabled={busy} className="ui-btn-primary">Unlock & verify</button>
        </form>}
        {selectedLocal && <button type="button" disabled={busy} className="ui-link text-sm" onClick={() => { void sync(selectedLocal).catch(() => setError("Public metadata sync failed. Your encrypted vault is still on this device.")); }}>Sync public metadata</button>}
      </section>}
      {approval.invalid&&<p role="alert" className="ui-alert-error">This approval link is invalid. Request a new link from the application.</p>}
      {approval.target&&selectedServer?.id!==approval.target.walletId&&<p role="alert" className="ui-alert-warn">Select the wallet named in the approval link, or sign in to its owner account. No payment has been approved.</p>}
      {!approval.invalid&&xrplPaymentsEnabled && selectedServer && !selectedCustody && <div id="send" className="scroll-mt-4"><XrpPayment key={selected} ownerId={ownerId} walletId={selectedServer.id} address={selected} hasLocalVault={!!selectedLocal} requestedIntentId={selectedServer.id===approval.target?.walletId?approval.target.intentId:undefined} /></div>}
      {!mainnet && <section className="space-y-4 ui-card p-5">
        <h2 className="text-lg font-medium">{mode === "create" ? "Create a Testnet wallet" : "Restore a Testnet wallet"}</h2>
        <div role="group" aria-label="Create or restore" className="ui-segment">{([["create", "Create new"], ["restore", "Restore"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} className="ui-segment-item" onClick={() => { lock(); setMode(value); }}>{label}</button>)}</div>
        <p className="text-sm text-stellar-muted">Recovery phrases use the standard XRP path (m/44'/144'/0'/0/0), so the same words open this wallet in Ledger, Xaman and other XRP wallets. Family seeds (s…) are supported for compatibility. Use a dedicated Testnet seed; the same seed controls the same address on other XRPL networks. Amma stores only your public address and wallet name. Logging in on another device does not recover your keys.</p>
        <form className="space-y-4" onSubmit={(event) => void save(event)} autoComplete="off">
          <label className="block space-y-1"><span>Wallet name</span><input required maxLength={64} className="ui-field" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label className="block space-y-1"><span>New local passphrase</span><input required type="password" minLength={12} maxLength={128} autoComplete="new-password" className="ui-field" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
          <label className="block space-y-1"><span>Confirm local passphrase</span><input required type="password" maxLength={128} autoComplete="new-password" className="ui-field" value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} /></label>
          <p className="text-xs text-stellar-muted">Use 12–128 characters, not only digits or spaces. A long, unique multi-word passphrase is recommended. If you lose it, restore using your offline seed; Amma cannot reset it.</p>
          {mode === "create" ? <>
            {!generatedSeed && <fieldset className="space-y-2"><legend className="text-sm">Recovery format</legend><div className="flex flex-wrap gap-3 text-sm">{([[24, "24 words"], [12, "12 words"], ["seed", "Family seed (advanced)"]] as const).map(([value, label]) => <label key={String(value)} className="flex items-center gap-2"><input type="radio" name="xrp-recovery-kind" checked={recoveryKind === value} onChange={() => setRecoveryKind(value)} />{label}</label>)}</div></fieldset>}
            {!generatedSeed && <button type="button" disabled={busy} className="ui-btn-primary" onClick={() => { try { validatePassphrase(passphrase); if (passphrase !== confirmPassphrase) { setError("The local passphrases do not match."); return; } const generated = recoveryKind === "seed" ? { ...createRecoverySeed() } : (({ phrase, address }) => ({ seed: phrase, address }))(createRecoveryPhrase(recoveryKind)); setGeneratedSeed(generated.seed); setGeneratedAddress(generated.address); setBackupVisible(true); setError(""); } catch (cause) { setError(message(cause)); } }}>{recoveryKind === "seed" ? "Create family seed" : "Create recovery phrase"}</button>}
            {generatedSeed && <div className="space-y-3 rounded-lg border border-amber-400/40 p-4"><p className="text-sm">{generatedSeed.includes(" ") ? `Write down these ${generatedSeed.split(" ").length} words in order, offline.` : "Write down this family seed offline."} Anyone with it controls this wallet. It is not a Stellar recovery phrase.</p>
              {backupVisible ? <>{generatedSeed.includes(" ") ? <p data-testid="recovery-seed" className="select-all rounded border border-stellar-border p-3 font-mono text-sm leading-relaxed">{generatedSeed}</p> : <code data-testid="recovery-seed" className="block break-all select-all text-sm">{generatedSeed}</code>}<button type="button" className="ui-btn-primary" onClick={() => setBackupVisible(false)}>I saved it — verify backup</button></> : <p className="text-sm">Seed hidden. Re-enter your offline copy below.</p>}
              <p className="break-all text-xs text-stellar-muted">Recovery address: {generatedAddress}</p>
            </div>}
          </> : <label className="block space-y-1"><span>Recovery phrase or family seed</span><input required type="password" autoComplete="off" spellCheck={false} maxLength={300} className="ui-field" value={seed} onChange={(event) => setSeed(event.target.value)} />{/\s/.test(seed.trim()) && <span className="block text-xs text-stellar-muted">{seed.trim().split(/\s+/).length} words (12 or 24 expected)</span>}</label>}
          {(mode === "restore" || (generatedSeed && !backupVisible)) && <>
            <label className="block space-y-1"><span>Re-enter recovery phrase or seed</span><input required type="password" autoComplete="off" spellCheck={false} maxLength={300} className="ui-field" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I saved it offline and understand that clearing browser storage removes this device's encrypted vault.</span></label>
            <button disabled={busy} className="ui-btn-primary">{busy ? "Saving encrypted wallet…" : "Save encrypted wallet"}</button>
          </>}
        </form>
      </section>}
    </div>
  </div>;
}
