import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useWalletStore } from "../store/wallet";
import { isLegacyPin } from "../lib/passphrase";
import { isPinRetiredError, PIN_RETIRED_MESSAGE } from "../lib/pin-retire";
import { useAuthStore } from "../store/auth";
import { useBalances } from "../hooks/useBalances";
import {
  buildPaymentTx, calculatePlatformFee, extractStellarError, makeMemo, validateMemo, memoLooksLikeHash, StellarSdk,
  type MemoType,
} from "../lib/stellar";
import { getNetworkConfig } from "../lib/constants";
import { planDestination, destinationOperation } from "../lib/destination-account";
import { signingApi, type FeeQuote } from "../lib/api";
import { affordability, spendableByAsset } from "../lib/send-affordable";
import { listCustodyWallets } from "../lib/custody-wallets";
import { CUSTODY_CHANGED } from "../lib/custody-onboard";
import PinModal from "../components/PinModal";
import TxConfirmation, { type KnownSend } from "../components/TxConfirmation";
import { extractTxHash, type StellarNetwork } from "../lib/stellar-tx-details";
import { ReviewPanel } from "../components/kit/ReviewPanel";
import { isWrongPassphrase, validateSend, type SendErrors } from "../lib/send-form";
import { toast } from "sonner";
import { classifySubmitError, clearPending, loadPending, lookupStellarTx, pendingSlot, savePending, stellarTxUrl, type PendingStellarSend } from "../lib/stellar-pending";

const MEMO_MAX_BYTES = 28;

const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

// Accepts "text" | "id" | "hash" (also "memo_text" style); anything else is text.
const parseMemoType = (raw: string | null): MemoType => {
  const v = (raw ?? "").toLowerCase().replace(/^memo_/, "");
  return v === "id" || v === "hash" ? v : "text";
};

export default function SendPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [destination, setDestination] = useState(searchParams.get("to") ?? "");
  const [memo, setMemo] = useState(searchParams.get("memo") ?? "");
  const [memoType, setMemoType] = useState<MemoType>(parseMemoType(searchParams.get("memoType")));
  const [reviewing, setReviewing] = useState(false);
  const [amount, setAmount] = useState("");
  const [assetCode, setAssetCode] = useState("XLM");
  const [showPin, setShowPin] = useState(false);
  const [errors, setErrors] = useState<SendErrors>({});
  const [sendError, setSendError] = useState("");
  const destinationRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [confirmation, setConfirmation] = useState<{ hash: string; network: StellarNetwork; known: KnownSend } | null>(null);
  // Amma-held Stellar wallet: the server signs after the account password, not the wallet passphrase.
  const [custody, setCustody] = useState<{ wallets: string[] } | "checking" | "failed">("checking");
  const [custodyTry, setCustodyTry] = useState(0);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const wasReviewing = useRef(false);
  // One envelope per review: retries of the same review send the same transaction (same sequence number), so it can apply only once.
  // `sends` counts the times it went to the server: from the second time on, a tx_ code is not proof it did not apply.
  // `innerHash`: the transaction the server will submit for this envelope (with the Amma fee added), from its fee quote.
  // `spendable`: what the wallet could spend per asset when the envelope was built (null when unknown).
  const envelope = useRef<{ key: string; xdr: string; hash: string; maxTime: number; sends: number; innerHash: string; spendable: Map<string, bigint> | null } | null>(null);
  // Delegated sends: the server's fee quote for the current envelope, shown in the review step before approval.
  const [quote, setQuote] = useState<{ key: string; quote: FeeQuote } | "loading" | "failed" | null>(null);
  const shownQuote = useRef<FeeQuote | null>(null);
  // Only the newest quote request may set the quote state, and only while the form still matches it.
  const quoteSeq = useRef(0);
  const latestKey = useRef("");
  // Self mode: whether the review's payment creates the account (then the browser charges no platform fee, like buildPaymentTx).
  const [selfDestKind, setSelfDestKind] = useState<string | null>(null);
  // The pending payment's outcome can't be told (only the browser's own hash was known): the user must check before sending again.
  const [pendingUnknown, setPendingUnknown] = useState(false);
  // A submitted payment whose outcome is not known yet. While it is set, no new envelope is built.
  const [pending, setPending] = useState<PendingStellarSend | null>(null);
  const [sent, setSent] = useState<{ hash: string; network: "testnet" | "public" } | null>(null);
  const [checkTick, setCheckTick] = useState(0);

  const { data: balances } = useBalances();
  const isUnlocked = useWalletStore((s) => s.isUnlocked);
  const getSecretKey = useWalletStore((s) => s.getSecretKey);
  const unlock = useWalletStore((s) => s.unlock);
  const publicKey = useWalletStore((s) => s.getPublicKey());
  const network = useWalletStore((s) => s.network);
  const signingMode = useAuthStore((s) => s.signingMode);
  const custodyUser = signingMode === "delegated" && typeof custody === "object" && !!publicKey && custody.wallets.includes(publicKey);
  const checkingCustody = signingMode === "delegated" && custody === "checking";
  const custodyCheckFailed = signingMode === "delegated" && custody === "failed";

  useEffect(() => {
    let live = true;
    const load = () => listCustodyWallets()
      .then((all) => { if (live) setCustody({ wallets: all.filter((w) => w.chain === "stellar").map((w) => w.address) }); })
      // 409 / 503 / 403-not-on-mainnet-list mean "no Amma-held wallets for this user" (own keys, setup off, or not on the mainnet custody list); anything else is a failed check.
      .catch((e: unknown) => { if (live) setCustody(/keep your own keys|does not hold|not switched on|not set up|aren't available for this account/i.test(e instanceof Error ? e.message : "") ? { wallets: [] } : "failed"); });
    void load();
    const again = () => { setCustody("checking"); void load(); };
    window.addEventListener(CUSTODY_CHANGED, again);
    return () => { live = false; window.removeEventListener(CUSTODY_CHANGED, again); };
  }, [custodyTry]);

  const selectedBalance = balances?.find((b) => b.assetCode === assetCode);
  const assetIssuer = selectedBalance?.assetIssuer;

  const dest = destination.trim();
  const memoValue = memo.trim();
  const memoErrorKey = memoValue ? validateMemo(memoType, memoValue) : null;
  const memoBytes = new TextEncoder().encode(memoValue).length;
  const memoErrorText: Record<string, string> = {
    "send.memoTooLong": t("send.memoTooLong", "Memo is too long (max 28 bytes)."),
    "send.memoIdInvalid": t("send.memoIdInvalid", "Memo ID must be a whole number from 0 to 18446744073709551615."),
    "send.memoHashInvalid": t("send.memoHashInvalid", "Memo hash must be exactly 64 hexadecimal characters."),
    "send.memoHashPrefix": t("send.memoHashPrefix", "Remove the 0x at the start."),
  };

  // Focus the review heading when it opens, and the Send button when going back.
  useEffect(() => {
    if (!reviewing && wasReviewing.current) sendButtonRef.current?.focus();
    wasReviewing.current = reviewing;
  }, [reviewing]);

  // Validate the form, then show the review panel (nothing is signed yet).
  const handleReview = () => {
    setSendError("");
    setSent(null);
    const found = validateSend({ destination, amount }, (a) => StellarSdk.StrKey.isValidEd25519PublicKey(a), t);
    setErrors(found);
    if (found.destination || found.amount) {
      (found.destination ? destinationRef : amountRef).current?.focus();
      return;
    }
    if (memoErrorKey) return;
    setReviewing(true);
    if (signingMode === "delegated") void refreshQuote();
    else {
      setSelfDestKind(null);
      const srv = new StellarSdk.Horizon.Server(getNetworkConfig(network).horizonUrl);
      void planDestination(srv, dest, assetCode === "XLM", amount).then((p) => setSelfDestKind(p.kind)).catch(() => setSelfDestKind(null));
    }
  };

  const copyDestination = async () => {
    try {
      await navigator.clipboard.writeText(dest);
    } catch {
      toast.error(t("send.copyFailed", "Could not copy the address. Select it and copy manually."));
    }
  };

  // Only reachable from "Confirm and send".
  const handleSend = async () => {
    if (signingMode === "delegated" || custodyUser) {
      // Delegated mode — ALWAYS need PIN for server-side decryption
      setShowPin(true);
      return;
    } else {
      // Self-signing mode — need PIN to unlock
      if (!isUnlocked) {
        setShowPin(true);
        return;
      }
      await executeSelfSend();
    }
  };

  // Called with the submit result (before resetForm clears the form) from every success path.
  const showConfirmation = (result: unknown) => {
    const hash = extractTxHash(result);
    if (hash) setConfirmation({ hash, network: useWalletStore.getState().network, known: { amount, assetCode, destination: dest, memoType, memo: memoValue } });
  };

  const resetForm = () => {
    setDestination("");
    setAmount("");
    setMemo("");
    setReviewing(false);
  };

  // Self-signing: frontend builds, signs, and submits
  const executeSelfSend = async () => {
    setLoading(true);
    try {
      const secretKey = getSecretKey();
      const submitted = await buildPaymentTx(
        secretKey,
        dest,
        amount,
        assetCode,
        assetIssuer === "native" ? undefined : assetIssuer,
        memoValue || undefined,
        memoType
      );
      toast.success(t("send.successMessage", { amount, code: assetCode }));
      showConfirmation(submitted);
      resetForm();
    } catch (err) {
      setSendError(extractStellarError(err));
    } finally {
      setLoading(false);
    }
  };

  // A payment still unknown when this tab was reloaded is checked again.
  useEffect(() => {
    if (publicKey) setPending(loadPending(network, publicKey));
  }, [network, publicKey]);
  // Another tab saved or cleared a pending payment for this wallet: follow it (no second envelope while one may land).
  useEffect(() => {
    if (!publicKey) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === pendingSlot(network, publicKey)) setPending(loadPending(network, publicKey));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [network, publicKey]);

  useEffect(() => {
    if (!pending || !publicKey) return;
    let live = true;
    const { horizonUrl } = getNetworkConfig(pending.network);
    const check = async () => {
      const outcome = await lookupStellarTx(horizonUrl, pending);
      if (!live || outcome === "waiting") return;
      // Only the browser's own hash is known and its time is up: say so, and keep new sends blocked until the user checks.
      if (outcome === "unknown") { setPendingUnknown(true); return; }
      clearPending(pending.network, publicKey);
      envelope.current = null;
      setPending(null);
      if (outcome === "applied") {
        setSent({ hash: pending.hash, network: pending.network });
        toast.success(t("send.pendingApplied", "Your payment went through."));
        resetForm();
      } else {
        setSendError(outcome === "failed"
          ? t("send.pendingFailed", "The network did not accept this payment, so nothing was sent. You can try again.")
          : t("send.pendingExpired", "This payment did not go through, so nothing was sent. You can try again."));
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5000);
    return () => { live = false; clearInterval(timer); };
  }, [pending, publicKey, checkTick]);
  useEffect(() => { setPendingUnknown(false); }, [pending]);

  const releaseUnknown = () => {
    if (!pending || !publicKey) return;
    clearPending(pending.network, publicKey);
    envelope.current = null;
    setPending(null);
    setPendingUnknown(false);
  };

  // The server's hash (its quote's innerHash, or the innerHash of its reply) when there is one; else the envelope's own, flagged so it is never read as "did not go through".
  const pendingOf = (env: { hash: string; maxTime: number; innerHash?: string }, hash = env.innerHash || env.hash, serverHash = !!env.innerHash || hash !== env.hash): PendingStellarSend =>
    ({ hash, maxTime: env.maxTime, network, summary: `${amount} ${assetCode} → ${shortAddress(dest)}`, ...(serverHash ? { serverHash: true } : {}) });
  // `hash`: the innerHash of the server's reply when it gave one. Else the quote's innerHash (the server's hash for this envelope).
  const startPending = (env: { hash: string; maxTime: number; innerHash?: string }, hash?: unknown) => {
    if (!publicKey) return;
    const p = typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? pendingOf(env, hash, true) : pendingOf(env);
    savePending(publicKey, p);
    setSendError("");
    setPending(p);
  };

  const reviewKeyOf = () => [network, publicKey, dest, amount, assetCode, assetIssuer ?? "", memoType, memoValue].join("|");
  latestKey.current = reviewKeyOf();
  // Fee lines and totals as shown: a fresh envelope may be sent without a new look only if these did not change.
  const quoteShape = (q: FeeQuote | null) => JSON.stringify(q ? [q.fee?.feeOperations ?? [], q.pays] : null);

  /**
   * Builds the unsigned envelope for this review (once per review: retries of the same review reuse it, same sequence number)
   * and asks the server for its fee quote. The quote's innerHash is the transaction the server will submit for this envelope,
   * so a lost reply is looked up by that hash, never by the browser's own pre-fee hash.
   */
  const refreshQuote = async () => {
    if (!publicKey) return null;
    const key = reviewKeyOf();
    const mine = ++quoteSeq.current;
    // A newer request, or a form that changed meanwhile, owns the quote state: never let this one overwrite it.
    const current = () => mine === quoteSeq.current && latestKey.current === key;
    setQuote("loading");
    let building = true;
    try {
      if (envelope.current?.key !== key) {
        const { horizonUrl, networkPassphrase: passphrase } = getNetworkConfig(network);
        const srv = new StellarSdk.Horizon.Server(horizonUrl);
        const account = await srv.loadAccount(publicKey);
        const asset =
          assetCode === "XLM"
            ? StellarSdk.Asset.native()
            : new StellarSdk.Asset(assetCode, assetIssuer === "native" ? undefined : assetIssuer);

        // An account that does not exist yet cannot be paid: XLM creates it, a token is refused.
        const plan = await planDestination(srv, dest, assetCode === "XLM", amount);
        if (plan.kind === "error") throw new Error(plan.message);

        // Unsigned: the server adds the Amma fee (shown in the review), signs, fee-bumps and submits.
        const builder = new StellarSdk.TransactionBuilder(account, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: passphrase,
        })
          .addOperation(destinationOperation(plan, { destination: dest, asset, amount }, StellarSdk.Operation))
          .setTimeout(300);
        if (memoValue) builder.addMemo(makeMemo(memoType, memoValue));
        const tx = builder.build();
        envelope.current = { key, xdr: tx.toEnvelope().toXDR("base64"), hash: tx.hash().toString("hex"), maxTime: Number(tx.timeBounds?.maxTime ?? 0), sends: 0, innerHash: "", spendable: spendableByAsset(account as unknown as Parameters<typeof spendableByAsset>[0]) };
      }
      const env = envelope.current!;
      building = false;
      const q = await signingApi.feeQuote(env.xdr);
      if (!current()) return null;
      if (envelope.current !== env || typeof q?.innerHash !== "string" || !/^[0-9a-f]{64}$/.test(q.innerHash)) throw new Error("bad quote");
      env.innerHash = q.innerHash;
      shownQuote.current = q;
      setQuote({ key, quote: q });
      return env;
    } catch (err) {
      if (!current()) return null;
      setQuote("failed");
      // A problem building the payment (for example a token the recipient can't hold) is shown like any send error.
      if (building) setSendError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  // Back to the review step with the new fee shown; nothing was signed. The dialog closes so Confirm must be pressed again.
  const feeChangedStop = (message: string) => {
    setShowPin(false);
    setSendError(message);
  };

  // Delegated: frontend builds unsigned XDR, backend signs + fee bumps + submits
  const executeDelegatedSend = async (secret?: string, showErrorInline = false) => {
    setLoading(true);
    try {
      if (!publicKey) throw new Error("No active wallet");
      if (pending) throw new Error(t("send.pendingBlock", "Wait until we know whether your last payment went through."));

      const { networkPassphrase: passphrase } = getNetworkConfig(network);
      if (envelope.current?.key !== reviewKeyOf() || !envelope.current.innerHash) {
        // A new envelope (after a rejection or expiry) needs its own quote. Send it only if the fee shown did not change.
        const before = quoteShape(shownQuote.current);
        const fresh = await refreshQuote();
        if (!fresh) throw new Error(t("send.feeQuoteFailed", "We couldn't work out the Amma fee. Try again."));
        if (quoteShape(shownQuote.current) !== before) { feeChangedStop(t("send.feeChanged", "The Amma fee changed. Check it and confirm again.")); return; }
      }
      const env = envelope.current!;

      // Send unsigned XDR to backend — it signs, adds fee, fee bumps, and submits
      let result: any;
      env.sends += 1;
      // Saved before the request leaves: a reload while it is in flight still finds the record, shows the card and looks the hash up.
      savePending(publicKey, pendingOf(env));
      try {
        result = custodyUser
          ? await signingApi.signAndSubmit(env.xdr, passphrase, secret, "password", env.innerHash)
          : await signingApi.signAndSubmit(env.xdr, passphrase, secret, "pin", env.innerHash);
      } catch (err) {
        const kind = classifySubmitError(err, env.sends > 1);
        // It may have applied (no answer, timeout, 5xx, not JSON, or a tx_ code on a re-send): look the hash up first.
        if (kind === "unknown") { startPending(env); return; }
        // The server answered without submitting it (or Horizon rejected it): nothing is pending any more.
        clearPending(network, publicKey);
        // Definite rejection only: the next attempt builds a new envelope. A "retry" refusal keeps this one.
        if (kind === "rejected") envelope.current = null;
        // The server's fee for this envelope changed since the quote (nothing was signed): quote the same envelope again, close
        // the password dialog and make the user look at the new fee and press Confirm again. The next password can't approve it unseen.
        if ((err as { code?: unknown })?.code === "fee_changed") {
          env.innerHash = "";
          await refreshQuote();
          feeChangedStop(err instanceof Error ? err.message : t("send.feeChanged", "The Amma fee changed. Check it and confirm again."));
          return;
        }
        throw err;
      }
      if (result?.status === "unknown") { startPending(env, result.innerHash); return; }

      if (result.success) {
        clearPending(network, publicKey);
        envelope.current = null;
        const feeLines = (result.fee?.feeOperations ?? []) as { asset: string; amount: string }[];
        const feeInfo = feeLines.length ? ` (${t("send.ammaFee", "Amma fee")}: ${feeLines.map((l) => `${l.amount} ${l.asset}`).join(" + ")})` : "";
        setSent({ hash: typeof result.hash === "string" ? result.hash : env.hash, network });
        toast.success(t("send.successMessage", { amount, code: assetCode }) + feeInfo);
        showConfirmation(result);
        resetForm();
      } else {
        throw new Error(result.error || "Transaction failed");
      }
    } catch (err: any) {
      // Wrong password/passphrase, limits and "try again later" show inside the dialog, which stays open.
      if (showErrorInline || isWrongPassphrase(err) || isPinRetiredError(err)) throw err;
      setSendError(extractStellarError(err));
    } finally {
      setLoading(false);
    }
  };

  // Self mode: the browser takes its 0.1% platform fee out of the amount (lib/stellar.ts buildPaymentTx, unchanged here).
  // Delegated mode: the server adds the Amma fee on top; the review shows the server's quote (fee and total).
  const isDelegated = signingMode === "delegated";
  const currentQuote = typeof quote === "object" && quote && quote.key === reviewKeyOf() ? quote.quote : null;
  // Amount plus the Amma fee more than the wallet can spend (XLM keeps its reserve): Confirm stays off and the reason says the most it can send.
  const spendable = envelope.current?.key === reviewKeyOf() ? envelope.current.spendable : null;
  const sendIssuer = assetCode === "XLM" || assetIssuer === "native" ? undefined : assetIssuer;
  // When Amma does not pay the network fee, the user's XLM pays it too: 100 stroops per operation (the client's bid) incl. the fee payments.
  const networkFee = currentQuote && !currentQuote.networkFeePaidByAmma ? BigInt(StellarSdk.BASE_FEE) * BigInt(1 + (currentQuote.fee?.feeOperations.length ?? 0)) : 0n;
  const shortfall = isDelegated && currentQuote && spendable ? affordability(currentQuote.pays, spendable, { asset: assetCode, issuer: sendIssuer, amount }, networkFee) : null;
  const delegatedFeeRows = !isDelegated ? [] : currentQuote ? [
    { label: t("send.networkFee", "Network fee"), value: currentQuote.networkFeePaidByAmma ? t("send.networkFeeAmma", "Paid by Amma") : t("send.networkFeeYou", "Paid from your wallet") },
    {
      label: t("send.ammaFee", "Amma fee"),
      value: (
        <span aria-live="polite">
          {currentQuote.fee?.feeOperations.length
            ? currentQuote.fee.feeOperations.map((l) => `${l.amount} ${l.asset}${l.xlmFallbackFor?.length ? ` (${t("send.feeInXlm", "in XLM, for")} ${l.xlmFallbackFor.join(", ")})` : ""}`).join(" + ")
            : t("send.noAmmaFee", "None")}
        </span>
      ),
    },
    { label: t("send.totalYouPay", "Total you pay"), value: currentQuote.pays.map((x) => `${x.upTo ? `${t("send.upTo", "up to")} ` : ""}${x.amount} ${x.asset}`).join(" + ") },
  ] : quote === "failed" ? [{
    label: t("send.ammaFee", "Amma fee"),
    value: (
      <span id="send-fee-status" role="alert">
        {t("send.feeQuoteFailed", "We couldn't work out the Amma fee. Try again.")}{" "}
        <button type="button" className="min-h-[44px] underline" onClick={() => void refreshQuote()}>{t("send.tryAgain", "Try again")}</button>
      </span>
    ),
  }] : [{ label: t("send.ammaFee", "Amma fee"), value: <span id="send-fee-status" role="status" aria-live="polite">{t("send.feeLoading", "Working out the fee…")}</span> }];
  // Self mode, same rule as buildPaymentTx: 0.1% out of the amount, none when the payment creates the account.
  const selfCreates = !isDelegated && selfDestKind === "createAccount";
  const feeAmount = amount && !isDelegated && !selfCreates ? calculatePlatformFee(amount) : "0";
  const netAmount = feeAmount !== "0" ? (parseFloat(amount) - parseFloat(feeAmount)).toFixed(7) : amount;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-stellar-text">{t("send.title")}</h1>
      {confirmation && <TxConfirmation key={confirmation.hash} {...confirmation} />}

      {pending && (
        <div role="status" aria-live="polite" className="ui-alert ui-alert-warn space-y-1 max-w-lg">
          <p>{t("send.pendingTitle", "We don't know yet whether this payment went through. Don't send it again until this clears.")}</p>
          {pending.summary && <p>{pending.summary}</p>}
          <p className="font-mono text-xs break-all">{pending.hash}</p>
          {pendingUnknown && (
            <>
              <p>{t("send.pendingUnknown", "We can't tell whether this payment went through. Check your balance and history before you send it again.")}</p>
              <button type="button" className="min-h-[44px] underline" onClick={releaseUnknown}>{t("send.pendingRelease", "I checked. Let me send again")}</button>
            </>
          )}
          <div className="flex gap-3">
            <a href={stellarTxUrl(pending.network, pending.hash)} target="_blank" rel="noopener noreferrer" className="min-h-[44px] underline">{t("send.viewOnExplorer", "View on Stellar Expert")}</a>
            <button type="button" className="min-h-[44px] underline" onClick={() => setCheckTick((n) => n + 1)}>{t("send.pendingCheck", "Check again")}</button>
          </div>
        </div>
      )}
      {sent && !pending && (
        <div role="status" className="ui-alert ui-alert-ok space-y-1 max-w-lg">
          <p>{t("send.sentTitle", "Payment sent.")}</p>
          <p className="font-mono text-xs break-all">{sent.hash}</p>
          <a href={stellarTxUrl(sent.network, sent.hash)} target="_blank" rel="noopener noreferrer" className="min-h-[44px] underline">{t("send.viewOnExplorer", "View on Stellar Expert")}</a>
        </div>
      )}

      {reviewing ? (
        <ReviewPanel
          titleId="send-review-title"
          errorId="send-error"
          title={t("send.reviewTitle", "Review payment")}
          rows={[
            {
              label: t("send.destination", "Destination Address"),
              value: (
                <>
                  <span className="block font-mono" aria-hidden="true">{shortAddress(dest)}</span>
                  <span className="block text-xs text-stellar-muted font-mono break-all select-all">{dest}</span>
                  <button type="button" onClick={copyDestination} className="ui-btn ui-btn-ghost mt-1">
                    {t("send.copyAddress", "Copy address")}
                  </button>
                </>
              ),
            },
            { label: t("send.amount", "Amount"), value: `${amount} ${assetCode}` },
            ...(feeAmount !== "0"
              ? [
                  { label: t("send.platformFee", "Platform fee"), value: `${feeAmount} ${assetCode}` },
                  { label: t("send.recipientGets", "Recipient gets"), value: `${netAmount} ${assetCode}` },
                ]
              : []),
            ...(selfCreates ? [{ label: t("send.platformFee", "Platform fee"), value: t("send.platformFeeNoneNewAccount", "None: this payment creates the account") }] : []),
            ...delegatedFeeRows,
            {
              label: t("send.memo", "Memo (optional)"),
              value: memoValue ? `${memoValue} (${memoType})` : t("send.noMemo", "No memo"),
            },
          ]}
          error={sendError}
          busy={loading}
          confirmDisabled={!!pending || (isDelegated && !currentQuote) || !!shortfall}
          confirmDescribedBy={isDelegated && !currentQuote ? "send-fee-status" : shortfall ? "send-balance-reason" : undefined}
          onBack={() => setReviewing(false)}
          onConfirm={handleSend}
          backLabel={t("send.back", "Back")}
          confirmLabel={t("send.confirmSend", "Confirm and send")}
          busyLabel={t("send.sending")}
        >
          {shortfall && (
            <p id="send-balance-reason" role="alert" className="ui-alert ui-alert-warn">
              {currentQuote?.fee ? t("send.overBalance", "Not enough for the amount plus the Amma fee.") : t("send.notEnoughForAmount", "Not enough for this amount.")}{" "}
              {shortfall.isSendAsset
                ? `${t("send.maxYouCanSend", "The most you can send is")} ${shortfall.max} ${shortfall.asset}.`
                : `${t("send.feeNeeds", "The Amma fee needs")} ${shortfall.need} ${shortfall.asset}, ${t("send.youHave", "and you have")} ${shortfall.have} ${shortfall.asset}.`}
              {shortfall.asset === "XLM" ? ` ${t("send.reserveNote", "Your account keeps its minimum XLM reserve.")}` : ""}
            </p>
          )}
          {!memoValue && (
            <div className="ui-alert ui-alert-warn">
              {t("send.exchangeHint", "Sending to an exchange? Add the memo they gave you, or the funds may be lost.")}
            </div>
          )}
        </ReviewPanel>
      ) : (
      <div className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-4 max-w-lg">
        {signingMode === "delegated" && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-stellar-blue/10 border border-stellar-blue/20">
            <span className="text-xs text-stellar-link">Delegated mode — platform pays network fees</span>
          </div>
        )}

        <div>
          <label htmlFor="send-asset" className="block text-sm text-stellar-muted mb-1">{t("send.asset")}</label>
          <select
            id="send-asset"
            value={assetCode}
            onChange={(e) => setAssetCode(e.target.value)}
            className="w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text focus:outline-none focus:border-stellar-blue"
          >
            {balances?.map((b) => (
              <option key={`${b.assetCode}-${b.assetIssuer}`} value={b.assetCode}>
                {b.assetCode} — {parseFloat(b.balance).toFixed(4)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="send-destination" className="block text-sm text-stellar-muted mb-1">{t("send.destination")}</label>
          <input
            id="send-destination"
            ref={destinationRef}
            type="text"
            aria-invalid={errors.destination ? true : undefined}
            aria-describedby={errors.destination ? "send-destination-error" : undefined}
            autoComplete="off"
            spellCheck={false}
            value={destination}
            onChange={(e) => { setDestination(e.target.value); setErrors((x) => ({ ...x, destination: undefined })); setSendError(""); }}
            placeholder={t("send.destinationPlaceholder")}
            className="w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue font-mono text-sm"
          />
          {errors.destination && <p id="send-destination-error" role="alert" className="mt-1 text-sm text-stellar-danger-text">{errors.destination}</p>}
        </div>

        <div>
          <label htmlFor="send-amount" className="block text-sm text-stellar-muted mb-1">{t("send.amount")}</label>
          <input
            id="send-amount"
            ref={amountRef}
            type="number"
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={errors.amount ? "send-amount-error" : undefined}
            inputMode="decimal"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setErrors((x) => ({ ...x, amount: undefined })); setSendError(""); }}
            placeholder="0.00"
            step="any"
            min="0"
            className="w-full px-4 py-3 rounded-lg bg-stellar-dark border border-stellar-border text-stellar-text placeholder:text-stellar-muted focus:outline-none focus:border-stellar-blue"
          />
          {errors.amount && <p id="send-amount-error" role="alert" className="mt-1 text-sm text-stellar-danger-text">{errors.amount}</p>}
        </div>

        <div>
          <label htmlFor="send-memo" className="ui-label">{t("send.memo", "Memo (optional)")}</label>
          <div className="flex gap-2">
            <select
              id="send-memo-type"
              aria-label={t("send.memoType", "Memo type")}
              value={memoType}
              onChange={(e) => setMemoType(e.target.value as MemoType)}
              className="ui-field w-auto"
            >
              <option value="text">{t("send.memoTypeText", "Text")}</option>
              <option value="id">{t("send.memoTypeId", "ID")}</option>
              <option value="hash">{t("send.memoTypeHash", "Hash")}</option>
            </select>
            <input
              id="send-memo"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder={t("send.memoPlaceholder", "Add a memo for the recipient")}
              aria-invalid={!!memoErrorKey}
              aria-describedby="send-memo-help"
              className="ui-field"
            />
          </div>
          <div id="send-memo-help" className="text-xs mt-1">
            {memoErrorKey && (
              <div role="alert" className="text-red-400">{memoErrorText[memoErrorKey]}</div>
            )}
            {memoType === "text" && memoLooksLikeHash(memoValue) && (
              <div data-testid="memo-hash-warning" role="status" aria-live="polite" className="text-amber-700 dark:text-amber-400">
                {t("send.memoLooksLikeHash", "This looks like a hash memo. A Text memo with the same characters will NOT match a payment request that expects a Hash memo.")}
              </div>
            )}
            {memoType === "text" && (
              <div className="text-stellar-muted">{memoBytes}/{MEMO_MAX_BYTES}</div>
            )}
          </div>
        </div>

        {amount && parseFloat(amount) > 0 && (isDelegated || feeAmount !== "0") && (
          <div className="text-xs text-stellar-muted space-y-1 px-1">
            {feeAmount !== "0" && (
              <>
                <div className="flex justify-between">
                  <span>Recipient receives:</span>
                  <span className="text-stellar-text">{parseFloat(netAmount).toFixed(7)} {assetCode}</span>
                </div>
                <div className="flex justify-between">
                  <span>{t("send.platformFeeSelf", "Platform fee (0.1%, none when this creates a new account)")}:</span>
                  <span className="text-amber-700 dark:text-amber-400">{feeAmount} {assetCode}</span>
                </div>
              </>
            )}
            {isDelegated && (
              <>
                <div className="flex justify-between">
                  <span>Network fee:</span>
                  <span className="text-green-700 dark:text-green-400">Paid by platform</span>
                </div>
                <div className="flex justify-between">
                  <span>{t("send.ammaFee", "Amma fee")}:</span>
                  <span>{t("send.ammaFeeOnReview", "Added on top, shown before you confirm")}</span>
                </div>
              </>
            )}
          </div>
        )}

        {checkingCustody && <p role="status" className="text-xs text-stellar-muted">Checking your wallet…</p>}
        {custodyCheckFailed && (
          <p role="alert" className="text-sm text-stellar-danger-text">
            We could not check how your wallet signs. <button type="button" className="min-h-[44px] underline" onClick={() => { setCustody("checking"); setCustodyTry((n) => n + 1); }}>Try again</button>
          </p>
        )}
        {sendError && <p id="send-error" role="alert" className="text-sm text-stellar-danger-text">{sendError}</p>}

        <button
          ref={sendButtonRef}
          onClick={handleReview}
          disabled={loading || !!pending || !!memoErrorKey || checkingCustody || custodyCheckFailed}
          className="w-full py-3 rounded-lg bg-stellar-blue text-white font-medium hover:bg-stellar-purple transition-colors disabled:opacity-50"
        >
          {loading ? t("send.sending") : t("send.sendButton", { code: assetCode })}
        </button>
      </div>
      )}

      {showPin && (
        <PinModal
          title={custodyUser ? "Enter your Amma password to send" : t("send.unlockToSend")}
          accountPassword={custodyUser}
          onSubmit={async (pin) => {
            if (custodyUser) {
              await executeDelegatedSend(pin, true);
              setShowPin(false);
              return;
            }
            // Wallet PINs are retired: a short PIN never signs. Close this and offer the move to the Amma account (lib/pin-retire.ts).
            const retire = () => { setShowPin(false); setSendError(PIN_RETIRED_MESSAGE); useWalletStore.setState({ needsPassphraseUpgrade: true }); };
            if (isLegacyPin(pin)) return retire();
            try {
              if (signingMode === "delegated") {
                // The server decrypts with the PIN; the browser holds no encrypted secret after sign-in.
                await executeDelegatedSend(pin);
                setShowPin(false);
              } else {
                await unlock(pin);
                setShowPin(false);
                await executeSelfSend();
              }
            } catch (err) {
              if (isPinRetiredError(err)) return retire();
              throw err;
            }
          }}
          onCancel={() => setShowPin(false)}
        />
      )}
    </div>
  );
}
