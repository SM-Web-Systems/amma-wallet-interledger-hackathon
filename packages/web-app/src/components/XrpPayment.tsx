import { useCallback, useEffect, useRef, useState } from "react";
import { isValidClassicAddress } from "xrpl";
import { xrplPaymentApi } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { signApprovedPayment, VaultError } from "../lib/xrpl/vault";
import { assertIntentContext, assertPreparedPayment, formatXrp, parseXrp, sameRequest, type PaymentInput, type PaymentIntent } from "../lib/xrpl/payment";
import { XRP_PAYMENT_LOCK_EVENT } from "../lib/xrpl/feature";
import { pollAvailability } from "../lib/xrpl/availability-poll";

const unresolved = (payment: PaymentIntent) => ["prepared","signed","submitted"].includes(payment.state);
const needsReview=(payment:PaymentIntent)=>["INTEGRITY_MISMATCH","LEDGER_RESET","SEQUENCE_CONSUMED","TRANSACTION_ALREADY_BOUND"].includes(payment.lastObservation??"");
function failure(cause: unknown): string {
  if (cause instanceof VaultError) return cause.message === "UNLOCK_FAILED" ? "The local passphrase is incorrect or the vault was changed." : "Local signing could not be verified. Check your passphrase or restore the wallet.";
  const message = cause instanceof Error ? cause.message : "";
  const known: Record<string,string> = {
    "XRPL SUBMISSION PAUSED":"Payment submission is paused by the operator. Saved payments remain available for status checks.",
    "XRPL CONTROL UNAVAILABLE":"Payment submission is unavailable. Check saved payments and wait for the operator to restore the service.",
    "PAYMENT UNRESOLVED":"This wallet has another payment that is still being confirmed. It settles or expires on its own, usually within about 2 minutes on Testnet. Check its status, then try again.",
    "RECOVERY IN PROGRESS":"Nothing was sent just now: automatic recovery is already handling this payment. Check its status again in about 2 minutes. Do not create a replacement payment.",
    "TAG REQUIRED":"The destination requires a destination tag. Check it with the recipient.",
    "INSUFFICIENT SPENDABLE BALANCE":"The available XRP cannot cover the amount, account reserve and fee.",
    "FEE LIMIT EXCEEDED":"The required fee exceeds your fee ceiling. No payment was approved.",
    "UNSUPPORTED SIGNING CONFIGURATION":"This account uses signing settings that Amma does not support yet.",
    "DESTINATION RESERVE REQUIRED":"An unfunded destination must receive at least its account reserve.",
    "UNSUPPORTED DESTINATION":"The destination has account settings that this payment flow does not support.",
    "XRPL PAYMENTS DISABLED":"Testnet payments are unavailable on this deployment. Check the saved status of any earlier payment.",
    "PAYMENT INTEGRITY REVIEW REQUIRED":"This saved payment needs an integrity review. No successful receipt is available.",
  };
  return known[message] ?? "The payment operation could not be confirmed. Check its saved status before retrying; do not create a replacement payment.";
}

export default function XrpPayment({ ownerId, walletId, address, hasLocalVault, requestedIntentId }: { ownerId: string; walletId: string; address: string; hasLocalVault: boolean; requestedIntentId?: string }) {
  const [destination,setDestination] = useState("");
  const [tag,setTag] = useState("");
  const [amount,setAmount] = useState("");
  const [maxFee,setMaxFee] = useState("100");
  const [passphrase,setPassphrase] = useState("");
  const [approved,setApproved] = useState(false);
  const [payments,setPayments] = useState<PaymentIntent[]>([]);
  const [selected,setSelected] = useState("");
  const [busy,setBusy] = useState(false);
  const [submissionAvailable,setSubmissionAvailable]=useState(false);
  const [error,setError] = useState("");
  const mounted = useRef(true), operation = useRef<AbortController | null>(null), pending = useRef(false);
  const draft = useRef<{ key: string; request: PaymentInput } | null>(null);
  const linked=useRef(false);
  const current = payments.find(payment => payment.id === selected);
  const lock = useCallback(() => { operation.current?.abort(); setPassphrase(""); setApproved(false); },[]);
  const valid = (controller: AbortController) => !controller.signal.aborted && mounted.current && useAuthStore.getState().isAuthenticated && String(useAuthStore.getState().user?.id) === ownerId;
  const check = useCallback((payment: PaymentIntent) => { assertIntentContext(payment,walletId,address,ownerId); return payment; },[walletId,address,ownerId]);
  const remember = (payment: PaymentIntent) => {
    check(payment);if(["validated_success","validated_failure","expired","cancelled"].includes(payment.state))draft.current=null;
    setPayments(previous => [payment,...previous.filter(item=>item.id!==payment.id)]); setSelected(payment.id);
  };
  const load = useCallback(async () => {
    const [listed,requested,availability]=await Promise.all([xrplPaymentApi.list(walletId),requestedIntentId?xrplPaymentApi.status(requestedIntentId):Promise.resolve(null),xrplPaymentApi.availability().catch(()=>({available:false}))]);
    const rows=listed.map(check);
    if(requested){check(requested);if(requested.id!==requestedIntentId)throw new Error("Approval intent changed");rows.unshift(requested);}
    const unique=rows.filter((row,index)=>rows.findIndex(other=>other.id===row.id)===index);
    if (!mounted.current) return;
    setSubmissionAvailable(availability.available);
    setPayments(unique);
    if(requested&&!linked.current){linked.current=true;setSelected(requested.id);return;}
    setSelected(previous=>rows.some(payment=>payment.id===previous)?previous:(rows.find(unresolved)?.id??rows[0]?.id??""));
  },[walletId,check,requestedIntentId]);
  useEffect(() => {
    mounted.current=true; void load().catch(()=>{if(mounted.current)setError("Saved payments are unavailable. Retry loading before preparing another payment.");});
    window.addEventListener(XRP_PAYMENT_LOCK_EVENT,lock);
    return ()=>{mounted.current=false;operation.current?.abort();window.removeEventListener(XRP_PAYMENT_LOCK_EVENT,lock);};
  },[load,lock]);
  useEffect(()=>{
    if(submissionAvailable)return;
    return pollAvailability(()=>xrplPaymentApi.availability(),available=>{if(mounted.current)setSubmissionAvailable(available);},30000);
  },[submissionAvailable]);
  useEffect(()=>{setApproved(false);setPassphrase("");},[selected]);
  useEffect(()=>{
    if(!current)return;
    const finished=["validated_success","validated_failure","expired","cancelled"].includes(current.state);
    // Creating an awaiting-approval intent is part of preparation, so it must
    // not abort that operation. Finished or quarantined work clears approval.
    if(finished||needsReview(current))lock();if(finished)draft.current=null;
  },[current?.id,current?.state,current?.lastObservation,lock]);
  useEffect(()=>{
    if (!current || needsReview(current)||!["prepared","signed","submitted"].includes(current.state)) return;
    let active=true;
    const timer=window.setInterval(()=>{
      if(pending.current)return;
      void xrplPaymentApi.status(current.id).then(payment=>{if(active&&mounted.current)remember(payment);}).catch(()=>{if(active)setError("Ledger status is unavailable. The saved payment remains unresolved.");});
    },8000);
    return ()=>{active=false;window.clearInterval(timer);};
  },[current?.id,current?.state,current?.lastObservation]);

  async function perform(work: (controller: AbortController)=>Promise<void>) {
    if(pending.current)return;
    const controller=new AbortController();operation.current=controller;pending.current=true;setBusy(true);setError("");
    try {await work(controller);} catch(cause) {if(valid(controller)){setError(failure(cause));await load().catch(()=>{});}}
    finally {pending.current=false;if(mounted.current){setBusy(false);setPassphrase("");setApproved(false);}}
  }
  async function checkSubmission(){
    const availability=await xrplPaymentApi.availability();if(mounted.current)setSubmissionAvailable(availability.available);
    if(!availability.available)throw new Error(availability.code.replaceAll("_"," "));
  }
  async function review(event: React.FormEvent) {
    event.preventDefault();
    let amountDrops: string;
    try {
      if(!isValidClassicAddress(destination)||destination===address)throw new Error("Enter a different checksum-valid classic XRP address. X-addresses are not supported.");
      amountDrops=parseXrp(amount);
      if(tag!==""&&(!/^(0|[1-9]\d{0,9})$/.test(tag)||BigInt(tag)>4294967295n))throw new Error("Use a destination tag from 0 to 4294967295, or leave it empty.");
      if(!/^[1-9]\d{0,3}$/.test(maxFee)||BigInt(maxFee)>1000n)throw new Error("The fee ceiling must be 1–1000 drops.");
    } catch(cause) {setError((cause as Error).message);return;}
    const body: PaymentInput={schemaVersion:1,walletId,chain:"xrpl",network:"testnet",destination,...(tag===""?{}:{destinationTag:Number(tag)}),amountDrops,maxFeeDrops:maxFee,reference:draft.current?.request.reference??crypto.randomUUID()};
    if(!draft.current||!sameRequest(body,draft.current.request))draft.current={key:crypto.randomUUID(),request:{...body,reference:crypto.randomUUID()}};
    const immutableDraft=structuredClone(draft.current);
    await perform(async controller=>{
      await checkSubmission();
      const created=check(await xrplPaymentApi.create(immutableDraft.request,immutableDraft.key));
      if(!sameRequest(created,immutableDraft.request))throw new Error("Server changed payment request");
      if(!valid(controller))return;
      remember(created);
      const prepared=check(await xrplPaymentApi.prepare(created.id));
      if(!sameRequest(prepared,immutableDraft.request)||!prepared.preparation)throw new Error("Server changed payment preparation");
      await assertPreparedPayment(prepared,prepared.preparation,address);
      if(valid(controller))remember(prepared);
    });
  }
  async function approve(event: React.FormEvent) {
    event.preventDefault();if(!approved||!current||!current.preparation||!hasLocalVault)return;
    const preview=structuredClone(check(current));let secret=passphrase;setPassphrase("");
    await perform(async controller=>{
      let signed:{blob:string;hash:string};
      try{await checkSubmission();signed=await signApprovedPayment(ownerId,address,secret,preview,controller.signal);}finally{secret="";}
      if(!valid(controller))return;
      const result=check(await xrplPaymentApi.submit(preview.id,preview.preparation!.preparationId,signed.blob));
      if(result.transactionHash!==signed.hash)throw new Error("Signed hash mismatch");
      if(valid(controller))remember(result);
    });
  }
  async function prepareSaved() {
    if(!current)return;
    const original=structuredClone(current);
    await perform(async controller=>{
      await checkSubmission();
      const prepared=check(await xrplPaymentApi.prepare(original.id));
      if(!sameRequest(prepared,original)||!prepared.preparation)throw new Error("Payment preview changed");
      await assertPreparedPayment(prepared,prepared.preparation,address);
      if(valid(controller))remember(prepared);
    });
  }
  async function status() { if(current)await perform(async controller=>{const row=check(await xrplPaymentApi.status(current.id));if(valid(controller))remember(row);}); }
  async function rebroadcast() { if(current)await perform(async controller=>{const row=check(await xrplPaymentApi.rebroadcast(current.id));if(valid(controller))remember(row);}); }
  const active=payments.some(unresolved);
  return <section aria-label="XRP Testnet payments" className="space-y-5 ui-card p-5">
    <h2 className="text-lg font-medium">Send Testnet XRP</h2>
    <p className="text-sm text-stellar-muted">Review every detail before approving. Only Testnet XRP is supported. A pending result is not confirmation of payment.</p>
    {!submissionAvailable&&<p role="status" className="text-sm text-amber-800 dark:text-amber-200">Payment submission is unavailable or paused. You can still check saved payment outcomes.</p>}
    {error&&<p role="alert" className="ui-alert-error">{error}</p>}
    <button type="button" className="ui-link text-sm" disabled={busy} onClick={()=>{void perform(async()=>{await load();});}}>Reload saved payments</button>
    {!active&&!requestedIntentId&&<form onSubmit={event=>void review(event)} className="space-y-3">
      <label className="block space-y-1"><span>Destination classic address</span><input required autoComplete="off" spellCheck={false} maxLength={35} className="ui-field" value={destination} onChange={e=>setDestination(e.target.value)}/></label>
      <label className="block space-y-1"><span>Destination tag (optional)</span><input inputMode="numeric" maxLength={10} className="ui-field" value={tag} onChange={e=>setTag(e.target.value)}/></label>
      <p className="text-xs text-stellar-muted">Use the tag supplied by the recipient. A tag of 0 differs from no tag.</p>
      <label className="block space-y-1"><span>Amount (XRP)</span><input required inputMode="decimal" maxLength={20} className="ui-field" value={amount} onChange={e=>setAmount(e.target.value)}/></label>
      <label className="block space-y-1"><span>Maximum fee (drops)</span><input required inputMode="numeric" maxLength={4} className="ui-field" value={maxFee} onChange={e=>setMaxFee(e.target.value)}/></label>
      <p className="text-xs text-stellar-muted">1 XRP = 1,000,000 drops. The actual fee is shown before approval. No platform fee is charged.</p>
      <button className="ui-btn-primary" disabled={busy||!submissionAvailable}>Review payment</button>
    </form>}
    {payments.length>0&&<label className="block space-y-1"><span>Saved payment</span><select aria-label="Saved payment" className="ui-field" value={selected} disabled={busy} onChange={e=>{lock();setSelected(e.target.value);}}>{payments.map(payment=><option key={payment.id} value={payment.id}>{formatXrp(payment.amountDrops)} XRP · {payment.state.replaceAll("_"," ")} · {payment.destination.slice(0,8)}…</option>)}</select></label>}
    {current&&<div className="space-y-3 rounded-lg border border-stellar-border p-4">
      <h3 className="font-medium">Payment details</h3>
      {current.application&&<p className="text-sm text-amber-800 dark:text-amber-200">Requested by {current.application.name} (application {current.application.tenantId}). Review the recipient and amount before approving.</p>}
      <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-stellar-muted">Network</dt><dd>XRPL Testnet</dd>
        <dt className="text-stellar-muted">Source</dt><dd className="break-all font-mono">{current.source}</dd>
        <dt className="text-stellar-muted">Destination</dt><dd className="break-all font-mono">{current.destination}</dd>
        <dt className="text-stellar-muted">Destination tag</dt><dd>{current.destinationTag===undefined?"None":current.destinationTag}</dd>
        <dt className="text-stellar-muted">Amount</dt><dd>{formatXrp(current.amountDrops)} XRP</dd>
        <dt className="text-stellar-muted">Maximum fee</dt><dd>{current.maxFeeDrops} drops</dd>
        {current.preparation&&<><dt className="text-stellar-muted">{current.state==="expired"?"Prepared fee (not charged)":"Actual fee"}</dt><dd>{current.preparation.feeDrops} drops ({formatXrp(current.preparation.feeDrops)} XRP)</dd><dt className="text-stellar-muted">{current.state==="expired"?"Prepared total":"Total cost"}</dt><dd>{formatXrp(current.preparation.totalDrops)} XRP</dd><dt className="text-stellar-muted">Ledger bound</dt><dd>{current.preparation.lastLedgerSequence}</dd></>}
        <dt className="text-stellar-muted">Reference</dt><dd className="break-all font-mono">{current.reference}</dd>
      </dl>
      {current.state==="awaiting_approval"&&<button type="button" disabled={busy||!submissionAvailable} className="ui-btn-primary" onClick={()=>void prepareSaved()}>Prepare saved payment</button>}
      {current.state==="prepared"&&!needsReview(current)&&submissionAvailable&&<>
        <p className="text-sm text-amber-800 dark:text-amber-200">This preview is reserved for this address. Approve it promptly. If you leave, check this saved payment before preparing another one.</p>
        {hasLocalVault?<form onSubmit={event=>void approve(event)} className="space-y-3" autoComplete="off">
          <label className="block space-y-1"><span>Payment vault passphrase</span><input required type="password" autoComplete="off" maxLength={128} className="ui-field" value={passphrase} onChange={e=>setPassphrase(e.target.value)}/></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" required checked={approved} onChange={e=>setApproved(e.target.checked)}/><span>I approve this exact Testnet payment, destination tag, amount and fee.</span></label>
          <button className="ui-btn-primary" disabled={busy||!approved}>{busy?"Checking payment…":"Approve & sign Testnet payment"}</button>
        </form>:<p className="text-sm">Restore this wallet's encrypted vault on this device before approving.</p>}
      </>}
      {["signed","submitted"].includes(current.state)&&<p role="status" className="text-sm text-amber-800 dark:text-amber-200">Pending — no final ledger result yet. Do not create a replacement payment.</p>}
      {current.lastObservation==="INTEGRITY_MISMATCH"&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">Ledger evidence does not match the approved payment. This outcome needs review; no successful receipt is available.</p>}
      {current.state==="validated_failure"&&<p role="status" className="text-sm text-red-700 dark:text-red-300">Validated transaction failure: {current.resultCode}. A network fee may have been charged. No payment receipt was issued.</p>}
      {current.state==="expired"&&<p role="status" className="text-sm text-amber-800 dark:text-amber-200">Expired — validated ledger history confirms this attempt was not included. To try again, create and approve a new payment.</p>}
      {["LEDGER_RESET","SEQUENCE_CONSUMED","TRANSACTION_ALREADY_BOUND"].includes(current.lastObservation??"")&&<p role="alert" className="text-sm text-amber-800 dark:text-amber-200">This payment needs review because ledger history, the source sequence or transaction ownership changed. No replacement payment has been created.</p>}
      {current.lastObservation==="RETRY_BUDGET_EXHAUSTED"&&<p className="text-sm text-amber-800 dark:text-amber-200">Automatic broadcast retries have paused. Ledger checks continue; do not create a replacement while the result is unresolved.</p>}
      {current.state==="validated_success"&&current.receipt&&<div role="status" className="ui-alert-ok space-y-2">
        <p className="font-medium">Validated XRP Testnet payment</p>
        <p>Delivered: {formatXrp(current.receipt.deliveredAmountDrops)} XRP · Result: {current.receipt.result}</p>
        <p>Ledger: {current.receipt.ledgerIndex}</p><p className="break-all font-mono">Ledger hash: {current.receipt.ledgerHash}</p>
        <p className="break-all font-mono">Transaction: {current.receipt.transactionHash}</p>
        <p>Fee: {current.receipt.feeDrops} drops</p>
        <a className="ui-link" href={`https://testnet.xrpl.org/transactions/${current.receipt.transactionHash}`} target="_blank" rel="noopener noreferrer">View on Testnet explorer</a>
      </div>}
      <div className="flex flex-wrap gap-4 text-sm"><button type="button" disabled={busy} className="ui-link" onClick={()=>void status()}>Check ledger status</button>
        {["signed","submitted"].includes(current.state)&&!needsReview(current)&&<button type="button" disabled={busy} className="ui-link" onClick={()=>void rebroadcast()}>Retry saved transaction</button>}
      </div>
    </div>}
  </section>;
}
