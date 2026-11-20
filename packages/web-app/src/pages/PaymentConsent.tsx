import { useEffect,useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, ArrowRightLeft, Check, Clock, Globe, Loader2, Lock, ShieldCheck, Wallet, X } from 'lucide-react';
import { paymentRequest } from '../lib/payments';
import { accessTypeLabel, actionsLabel, grantAmount, grantInterval, otherConditions, paymentErrorText } from '../lib/payment-display';
type GrantAmount={value?:string|number;assetCode?:string;assetScale?:number};
type GrantAccess={type:string;identifier?:string;actions?:string[];limits?:{debitAmount?:GrantAmount;receiveAmount?:GrantAmount;interval?:string;receiver?:string}};
type ConsentGrant={client?:unknown;access?:GrantAccess[];access_token?:{access?:GrantAccess[]}};
export default function PaymentConsent(){
  const [params]=useSearchParams(),id=params.get('interactId')??params.get('id')??'',nonce=params.get('nonce')??'';
  const [grant,setGrant]=useState<{grant:ConsentGrant;hash:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState<null|'allow'|'deny'>(null);
  const path=`/consent/${encodeURIComponent(id)}/${encodeURIComponent(nonce)}`;
  // An aborted request (unmount or a changed link) is not an error the person needs to see.
  useEffect(()=>{const controller=new AbortController();void paymentRequest<typeof grant>(path,undefined,undefined,controller.signal).then(setGrant).catch(e=>{if(!controller.signal.aborted)setError(paymentErrorText(e));});return()=>controller.abort();},[path]);
  async function choose(approve:boolean){if(!grant)return;setBusy(approve?'allow':'deny');try{const result=await paymentRequest<{finishUrl:string}>(path,{hash:grant.hash,approve});window.location.assign(result.finishUrl);}catch(e){setError(paymentErrorText(e));setBusy(null);}}
  const access=grant?.grant.access_token?.access??grant?.grant.access??[];
  const client=typeof grant?.grant.client==='string'?grant.grant.client:'';
  const clientHost=hostOf(client);
  return <div className="flex min-h-screen items-start justify-center px-4 py-8 text-stellar-text sm:items-center">
    <main className="w-full max-w-md space-y-5">
      <div className="text-center">
        <img src="/favicon-128.png" alt="Amma Wallet" className="mx-auto mb-4 h-14 w-14 rounded-2xl"/>
        <h1 className="text-2xl font-bold">Payment permission</h1>
        <p className="mt-1 text-stellar-muted">Review what this application can do with your Amma payment account.</p>
      </div>
      {error&&<div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm"><AlertCircle size={18} className="mt-0.5 shrink-0 text-red-500" aria-hidden/><p className="break-words">{error}</p></div>}
      {!grant&&!error&&<div className="ui-card flex items-center justify-center gap-3 p-8 text-stellar-muted" role="status"><Loader2 size={20} className="animate-spin" aria-hidden/>Loading the request…</div>}
      {grant&&<section className="ui-card overflow-hidden" aria-label="Requested access">
        {client&&<div className="flex items-center gap-3 border-b border-stellar-border p-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-stellar-blue/15 text-stellar-purple"><Globe size={22} aria-hidden/></span>
          <div className="min-w-0"><p className="truncate font-semibold">{clientHost||'An application'}</p><p className="text-sm text-stellar-muted">is asking for access</p><p className="mt-0.5 break-all font-mono text-[11px] text-stellar-muted" title="Application wallet">Application wallet: {client}</p></div>
        </div>}
        <ul className="divide-y divide-stellar-border">
          {access.map((item,index)=>{const limits=item.limits??{};const extra=otherConditions(item as unknown as Record<string,unknown>);const debit=grantAmount(limits.debitAmount),receive=grantAmount(limits.receiveAmount),every=grantInterval(limits.interval);
            return <li key={index} className="space-y-3 p-5">
              <div className="flex items-start gap-3"><span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stellar-text/5 text-stellar-muted">{item.type==='outgoing-payment'?<ArrowRightLeft size={16} aria-hidden/>:<ShieldCheck size={16} aria-hidden/>}</span>
                <div className="min-w-0"><p className="font-medium">{accessTypeLabel(String(item.type))}</p>{!!item.actions?.length&&<p className="text-sm text-stellar-muted">Permissions: {actionsLabel(item.actions)}</p>}</div></div>
              {(item.identifier||debit||receive||every||limits.receiver)&&<dl className="grid sm:ml-11 grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-lg bg-stellar-dark/60 p-3 text-sm">
                {item.identifier&&<><dt className="text-stellar-muted">Account</dt><dd className="break-all font-mono text-xs leading-5">{item.identifier}</dd></>}
                {debit&&<><dt className="text-stellar-muted">Spending limit</dt><dd className="font-semibold">{debit}{every&&<span className="font-normal text-stellar-muted"> {every}</span>}</dd></>}
                {receive&&<><dt className="text-stellar-muted">{debit?'Receive limit':'Spending limit'}</dt><dd className="font-semibold">{receive}{!debit&&every&&<span className="font-normal text-stellar-muted"> {every}</span>}</dd></>}
                {!debit&&!receive&&every&&<><dt className="text-stellar-muted">Repeats</dt><dd>{every}</dd></>}
                {limits.receiver&&<><dt className="text-stellar-muted">Only to</dt><dd className="break-all font-mono text-xs leading-5">{String(limits.receiver)}</dd></>}
              </dl>}
              {extra.length>0&&<div role="group" aria-label="Other conditions" className="sm:ml-11 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs"><p className="font-medium text-amber-700 dark:text-amber-300">Other conditions in this request</p><dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">{extra.map(([name,value])=><div key={name} className="contents"><dt className="text-stellar-muted">{name}</dt><dd className="break-all font-mono">{value}</dd></div>)}</dl></div>}
              {item.type==='outgoing-payment'&&!debit&&!receive&&!extra.length&&<p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300"><Clock size={13} className="mt-0.5 shrink-0" aria-hidden/>No spending limit was requested.</p>}
            </li>;})}
        </ul>
      </section>}
      <div className="grid grid-cols-2 gap-3">
        <button className="ui-btn-secondary" disabled={!!busy||!grant} onClick={()=>void choose(false)}>{busy==='deny'?<Loader2 size={16} className="animate-spin" aria-hidden/>:<X size={16} aria-hidden/>}Deny</button>
        <button className="ui-btn-primary" disabled={!!busy||!grant} onClick={()=>void choose(true)}>{busy==='allow'?<Loader2 size={16} className="animate-spin" aria-hidden/>:<Check size={16} aria-hidden/>}Allow</button>
      </div>
      <p className="flex items-start justify-center gap-2 text-center text-xs text-stellar-muted"><Lock size={13} className="mt-px shrink-0" aria-hidden/><span>Only allow applications you recognise and trust. Your wallet keys are never shared with them.</span></p>
      <p className="flex items-center justify-center gap-1.5 text-xs text-stellar-muted"><Wallet size={13} aria-hidden/>Amma Wallet · Open Payments</p>
    </main>
  </div>;
}
function hostOf(url:string){try{return new URL(url).host;}catch{return '';}}
