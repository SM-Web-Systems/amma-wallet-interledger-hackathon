import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import clsx from 'clsx';
import { AlertCircle, AlertTriangle, ArrowLeft, ArrowRight, BadgeCheck, Camera, CameraOff, Check, CheckCircle2, ChevronDown, ChevronRight, Clock, Copy, FlaskConical, KeyRound, Loader2, Lock, PauseCircle, PenLine, QrCode, ReceiptText, RefreshCw, ScanLine, ShieldCheck, Sparkles, Store, Undo2, Wallet, X } from 'lucide-react';
import { StatusChip } from '../components/kit/StatusChip';
import { TONE_CLASSES, chainLabel, executionShortLabel, executionStatus, legStatus, paymentErrorText, sourceReason } from '../lib/payment-display';
import { useAuthStore } from '../store/auth';
import { useWalletStore } from '../store/wallet';
import { listLocalWallets } from '../lib/xrpl/vault';
import { formatUnits, parseUnits, paymentRequest, requestIdFromLink, signFunding, type PaymentAsset, type PaymentExecution, type PaymentInvoice, type PaymentQuote,type PaymentSource } from '../lib/payments';

export default function Payments(){
  const owner=String(useAuthStore(s=>s.user?.id??''));
  const [params,setParams]=useSearchParams();
  const [availability,setAvailability]=useState<{enabled:boolean;paused:boolean;assets:PaymentAsset[]}|null>(null);
  const [invoice,setInvoice]=useState<PaymentInvoice|null>(null),[quote,setQuote]=useState<PaymentQuote|null>(null),[execution,setExecution]=useState<PaymentExecution|null>(null);
  const [link,setLink]=useState(params.get('request')??''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [tab,setTab]=useState<'pay'|'request'>('pay'),[merchant,setMerchant]=useState(''),[amount,setAmount]=useState(''),[assetIndex,setAssetIndex]=useState(0);
  const [passphrases,setPassphrases]=useState<Record<string,string>>({});
  const [scanning,setScanning]=useState(false);
  const [copied,setCopied]=useState(false),[now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const [history,setHistory]=useState<PaymentExecution[]>([]),[sources,setSources]=useState<PaymentSource[]>([]),[excluded,setExcluded]=useState<string[]>([]);
  const abort=useRef(new AbortController()),alive=useRef(true),video=useRef<HTMLVideoElement>(null),stream=useRef<MediaStream|null>(null);
  const idempotency=useRef<Record<string,string>>({});
  // One key per attempt: a failed attempt keeps its key so a retry cannot duplicate, a finished one drops it so the next sale is new.
  const key=(operation:string)=>idempotency.current[operation]??(idempotency.current[operation]=crypto.randomUUID());
  const finished=(operation:string)=>{delete idempotency.current[operation];};
  const submitting=useRef(false);
  useEffect(()=>{
    alive.current=true;abort.current=new AbortController();
    void paymentRequest<typeof availability>('/availability',undefined,undefined,abort.current.signal).then(setAvailability).catch(e=>setError(paymentErrorText(e)));
    void paymentRequest<PaymentExecution[]>('/history',undefined,undefined,abort.current.signal).then(setHistory).catch(()=>{});
    void paymentRequest<PaymentSource[]>('/sources',undefined,undefined,abort.current.signal).then(async available=>{
      const localXrp=await listLocalWallets(owner).catch(()=>[]),localStellar=useWalletStore.getState().accounts;
      const eligible=available.map(source=>({...source,reason:source.reason??(
        source.adapter==='stellar'&&!localStellar.some(a=>a.publicKey===source.address&&a.encryptedSecret)?'RESTORE_WALLET_ON_THIS_DEVICE':
        source.adapter==='xrpl'&&!localXrp.some(a=>a.address===source.address)?'RESTORE_WALLET_ON_THIS_DEVICE':undefined)}));
      if(alive.current)setSources(eligible);
    }).catch(()=>{});
    const lock=()=>{abort.current.abort();setPassphrases({});stream.current?.getTracks().forEach(t=>t.stop());};
    const hidden=()=>{if(document.hidden)lock();else abort.current=new AbortController();};
    document.addEventListener('visibilitychange',hidden);window.addEventListener('amma:xrpl:lock',lock);
    return()=>{alive.current=false;lock();document.removeEventListener('visibilitychange',hidden);window.removeEventListener('amma:xrpl:lock',lock);};
  },[owner]);
  useEffect(()=>{
    const id=params.get('request');if(!id)return;const controller=new AbortController();
    void paymentRequest<PaymentInvoice>(`/requests/${encodeURIComponent(id)}`,undefined,undefined,controller.signal).then(setInvoice).catch(e=>{if(!controller.signal.aborted)setError(paymentErrorText(e));});
    return()=>controller.abort();
  },[params.get('request'),owner]);
  useEffect(()=>{
    const id=params.get('execution');if(!id)return;
    let stopped=false;
    const poll=async()=>{try{const next=await paymentRequest<PaymentExecution>(`/executions/${encodeURIComponent(id)}`);if(!stopped)setExecution(next);}catch(e){if(!stopped)setError(paymentErrorText(e));}};
    void poll();const timer=setInterval(()=>void poll(),3000);return()=>{stopped=true;clearInterval(timer);};
  },[params,owner]);
  async function work(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){if(alive.current)setError(paymentErrorText(e));}finally{if(alive.current)setBusy(false);}}
  async function load(value=link){await work(async()=>{
    const id=requestIdFromLink(value),next=await paymentRequest<PaymentInvoice>(`/requests/${id}`);
    setInvoice(next);setQuote(null);setExecution(null);setParams({request:id});
  });}
  async function getQuote(){if(!invoice)return;await work(async()=>{
    setQuote(await paymentRequest<PaymentQuote>('/quotes',{requestId:invoice.id,excludedSources:[...new Set([...excluded,...sources.filter(s=>s.reason).map(s=>s.id)])]},crypto.randomUUID()));
  });}
  async function openAddress(){if(submitting.current)return;submitting.current=true;await work(async()=>{
    const asset=availability!.assets[assetIndex],operation=`remote:${link}:${assetIndex}:${parseUnits(amount,asset.scale)}`;
    const next=await paymentRequest<PaymentInvoice>('/requests/remote',{walletAddress:link,asset,amount:parseUnits(amount,asset.scale)},key(operation));
    finished(operation);
    setInvoice(next);setQuote(null);setExecution(null);setParams({request:next.id});
  });submitting.current=false;}
  async function approve(){if(!quote)return;await work(async()=>{
    const next=await paymentRequest<PaymentExecution>('/approvals',{quoteId:quote.id,hash:quote.hash},key(`approve:${quote.id}`));
    if(abort.current.signal.aborted)return;
    setExecution(next);setParams({execution:next.id});
  });}
  async function createInvoice(){if(submitting.current)return;submitting.current=true;await work(async()=>{
    const asset=availability!.assets[assetIndex],operation=`invoice:${merchant}:${assetIndex}:${parseUnits(amount,asset.scale)}`;
    const address=await paymentRequest<{url:string}>('/addresses',{asset,publicName:merchant},key(`address:${assetIndex}:${merchant}`));
    const next=await paymentRequest<PaymentInvoice>('/requests',{merchant,asset,amount:parseUnits(amount,asset.scale),reference:'Spaza or supplier invoice',walletAddress:address.url},key(operation));
    finished(operation);
    setInvoice(next);setQuote(null);
  });submitting.current=false;}
  async function sign(legId:string){if(!execution)return;const leg=execution.legs.find(l=>l.id===legId)!;
    const passphrase=passphrases[legId]??'';setPassphrases(p=>({...p,[legId]:''}));
    await work(async()=>{
      const signedTransaction=await signFunding(owner,execution,leg,passphrase,abort.current.signal);
      abort.current.signal.throwIfAborted();
      setExecution(await paymentRequest<PaymentExecution>(`/executions/${execution.id}/signatures`,{legId,signedTransaction},undefined,abort.current.signal));
    });
  }
  async function scan(){await work(async()=>{
    const Detector=(window as any).BarcodeDetector;if(!Detector)throw new Error('Camera scanning is unavailable in this browser. Paste the payment link instead.');
    stream.current=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});setScanning(true);
    try{
    if(!video.current)return;video.current.srcObject=stream.current;await video.current.play();
    const detector=new Detector({formats:['qr_code']});
    for(let i=0;i<200&&!abort.current.signal.aborted&&stream.current.getVideoTracks()[0]?.readyState==='live';i++){
      const codes=await detector.detect(video.current);
      if(codes[0]){stream.current.getTracks().forEach(t=>t.stop());setLink(codes[0].rawValue);await load(codes[0].rawValue);return;}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    stream.current.getTracks().forEach(t=>t.stop());
    }finally{stream.current?.getTracks().forEach(t=>t.stop());setScanning(false);}
  });}
  const payment=execution?.quote??quote;
  const shown=execution?.quote.invoice??invoice;
  const paymentLink=invoice?`${window.location.origin}/payments?request=${invoice.id}`:'';
  const quoteExpired=!!payment&&Date.parse(payment.expiresAt)<=now;
  const step=execution?(['paid','recovered'].includes(execution.state)?3:2):payment?1:0;
  const status=execution?executionStatus(execution.state):null;
  return <div className="min-h-screen text-stellar-text">
    <a href="#payments-main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-stellar-card focus:px-4 focus:py-2">Skip to payment</a>
    <header className="border-b border-stellar-border bg-stellar-card/60 backdrop-blur">
      <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3 sm:px-5">
        <Link to="/dashboard" className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-stellar-muted hover:bg-stellar-text/5 hover:text-stellar-text"><ArrowLeft size={16} aria-hidden/>Amma Wallet</Link>
        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-stellar-muted"><Lock size={13} aria-hidden/>Keys stay on this device</span>
      </div>
    </header>
    <main id="payments-main" className="mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-5 sm:py-8">
    <div className="flex items-start gap-4">
      <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-stellar-blue/15 text-stellar-purple sm:flex"><Store size={24} aria-hidden/></div>
      <div><h1 className="text-2xl font-bold sm:text-3xl">Everyday payments</h1><p className="mt-1 text-stellar-muted">Pay a shop or supplier using your available balances.</p></div>
    </div>
    {error&&<div role="alert" className="flex items-start gap-3 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm"><AlertCircle size={18} className="mt-0.5 shrink-0 text-red-500" aria-hidden/><p className="flex-1 break-words">{error}</p><button type="button" onClick={()=>setError('')} className="shrink-0 rounded p-0.5 text-stellar-muted hover:text-stellar-text" aria-label="Dismiss error"><X size={16}/></button></div>}
    {!availability&&!error&&<div className="flex items-center gap-3 text-stellar-muted" role="status"><Loader2 size={18} className="animate-spin" aria-hidden/>Checking payment availability…</div>}
    {availability&&!availability.enabled&&<p role="status" className="ui-card p-4 text-stellar-muted">Payments are not enabled on this deployment.</p>}
    {availability?.paused&&availability.enabled&&<p role="status" className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm"><PauseCircle size={18} className="mt-0.5 shrink-0 text-amber-500" aria-hidden/>Payments are paused. Existing payments can still be checked.</p>}
    <nav aria-label="Payment journeys" className="grid grid-cols-2 gap-1 rounded-xl border border-stellar-border bg-stellar-card p-1">
      {([['pay','Pay shop or supplier','Pay',ScanLine],['request','Request payment','Request',ReceiptText]] as const).map(([id,label,short,Icon])=><button key={id} type="button" aria-label={label} onClick={()=>setTab(id)} aria-pressed={tab===id} className={clsx('inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',tab===id?'bg-stellar-blue text-white shadow-sm':'text-stellar-muted hover:text-stellar-text')}><Icon size={16} aria-hidden/><span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span></button>)}
    </nav>
    {tab==='pay'&&availability?.enabled&&<ol aria-label="Payment progress" className="flex items-center gap-2 text-xs">
      {['Invoice','Review','Approve & sign','Done'].map((label,i)=><li key={label} aria-current={i===step?'step':undefined} className="flex flex-1 items-center gap-2">
        <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',i<step||(i===3&&step===3)?'bg-emerald-500 text-white':i===step?'bg-stellar-blue text-white':'border border-stellar-border text-stellar-muted')}>{i<step||(i===3&&step===3)?<Check size={13} aria-hidden/>:i+1}</span>
        <span className={clsx('sr-only sm:not-sr-only',i===step?'font-medium text-stellar-text':'text-stellar-muted')}>{label}</span>
        {i<3&&<span aria-hidden className={clsx('h-px flex-1',i<step?'bg-emerald-500/60':'bg-stellar-border')}/>}
      </li>)}
    </ol>}
    {availability?.enabled&&tab==='pay'&&!execution&&<section aria-labelledby="find-invoice" className="ui-card space-y-4 p-5">
      <h2 id="find-invoice" className="font-semibold">Find the invoice</h2>
      <div><label htmlFor="payment-link" className="ui-label">Payment link or request code</label><input id="payment-link" className="ui-field" placeholder="Paste a link or scan the shop’s QR code" value={link} onChange={e=>setLink(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&link&&!busy)void load();}}/></div>
      <div className="grid grid-cols-2 gap-3"><button className="ui-btn-secondary" disabled={busy} onClick={()=>void scan()}><Camera size={16} aria-hidden/>Scan QR</button><button className="ui-btn-primary" disabled={busy||!link} onClick={()=>void load()}>{busy&&!scanning?<Loader2 size={16} className="animate-spin" aria-hidden/>:<ArrowRight size={16} aria-hidden/>}Open invoice</button></div>
      <div className={scanning?'relative overflow-hidden rounded-xl bg-black':'hidden'}>
        <video ref={video} muted playsInline className="aspect-square w-full object-cover sm:aspect-video"/>
        <div aria-hidden className="pointer-events-none absolute inset-[18%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"/>
        <p className="absolute inset-x-0 bottom-3 text-center text-sm text-white" role="status">Point the camera at the shop’s QR code</p>
      </div>
      {scanning&&<button type="button" className="ui-btn-secondary w-full" onClick={()=>{stream.current?.getTracks().forEach(t=>t.stop());setScanning(false);}}><CameraOff size={16} aria-hidden/>Stop camera</button>}
      <details className="group rounded-xl border border-stellar-border p-4"><summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">Pay a supplier wallet address<ChevronDown size={16} className="text-stellar-muted transition-transform group-open:rotate-180" aria-hidden/></summary><div className="mt-4 space-y-4"><p className="text-sm text-stellar-muted">Paste the supplier’s Open Payments wallet address in the field above, then choose what they receive.</p><div className="grid gap-4 sm:grid-cols-2"><div><label htmlFor="supplier-asset" className="ui-label">Supplier receives</label><select id="supplier-asset" className="ui-field" value={assetIndex} onChange={e=>setAssetIndex(Number(e.target.value))}>{availability.assets.map((asset,i)=><option key={i} value={i}>{asset.code} · {asset.network}</option>)}</select></div><div><label htmlFor="supplier-amount" className="ui-label">Invoice amount</label><input id="supplier-amount" inputMode="decimal" placeholder="0.00" className="ui-field" value={amount} onChange={e=>setAmount(e.target.value)}/></div></div><button className="ui-btn-secondary w-full" disabled={busy||!amount||!link} onClick={()=>void openAddress()}>Open supplier payment</button></div></details>
    </section>}
    {availability?.enabled&&tab==='request'&&<form aria-labelledby="request-heading" className="ui-card space-y-4 p-5" onSubmit={e=>{e.preventDefault();void createInvoice();}}>
      <div><h2 id="request-heading" className="font-semibold">Request a payment</h2><p className="mt-1 text-sm text-stellar-muted">Create a QR code your customer can scan with Amma Wallet.</p></div>
      <div><label htmlFor="request-merchant" className="ui-label">Business name</label><input id="request-merchant" required maxLength={100} placeholder="e.g. Thandi’s Spaza" className="ui-field" value={merchant} onChange={e=>setMerchant(e.target.value)}/></div>
      <div className="grid gap-4 sm:grid-cols-2"><div><label htmlFor="request-asset" className="ui-label">Receive in</label><select id="request-asset" className="ui-field" value={assetIndex} onChange={e=>setAssetIndex(Number(e.target.value))}>{availability.assets.map((asset,i)=><option key={i} value={i}>{asset.code} · {asset.network}</option>)}</select></div>
      <div><label htmlFor="request-amount" className="ui-label">Amount</label><input id="request-amount" required inputMode="decimal" placeholder="0.00" className="ui-field" value={amount} onChange={e=>setAmount(e.target.value)}/></div></div>
      <button className="ui-btn-primary w-full" disabled={busy}>{busy?<Loader2 size={16} className="animate-spin" aria-hidden/>:<QrCode size={16} aria-hidden/>}Create payment request</button>
      {invoice&&<div className="flex flex-col items-center gap-4 rounded-xl border border-stellar-border bg-stellar-dark p-5 text-center">
        <p className="text-sm text-stellar-muted">{invoice.merchant} · <span className="font-semibold text-stellar-text">{formatUnits(invoice.amount,invoice.asset.scale)} {invoice.asset.code}</span></p>
        <div className="rounded-2xl bg-white p-4 shadow-sm"><QRCodeSVG value={paymentLink} size={208} aria-label="Payment request QR code"/></div>
        <p className="w-full break-all rounded-lg bg-stellar-card px-3 py-2 font-mono text-xs text-stellar-muted">{paymentLink}</p>
        <button type="button" className="ui-btn-secondary" onClick={()=>void navigator.clipboard.writeText(paymentLink).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000);})}>{copied?<Check size={16} className="text-emerald-500" aria-hidden/>:<Copy size={16} aria-hidden/>}{copied?'Copied':'Copy payment link'}</button>
      </div>}
    </form>}
    {tab==='pay'&&shown&&<section aria-labelledby="invoice-heading" className="ui-card overflow-hidden">
      <div className="bg-gradient-to-br from-stellar-blue/25 to-stellar-purple/10 p-5">
        <p className="flex items-center gap-2 text-sm text-stellar-muted"><Store size={15} aria-hidden/>Paying</p>
        <h2 id="invoice-heading" className="mt-1 text-xl font-semibold">{shown.merchant}</h2>
        <p className="mt-3 text-4xl font-bold tracking-tight">{formatUnits(shown.amount,shown.asset.scale)} <span className="text-2xl font-semibold text-stellar-muted">{shown.asset.code}</span></p>
        {shown.reference&&<p className="mt-2 text-xs text-stellar-muted">{shown.reference}</p>}
      </div>
      <div className="space-y-5 p-5">
      {!execution&&sources.length>0&&<details className="group rounded-xl border border-stellar-border p-4"><summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium"><span>Choose available funds <span className="font-normal text-stellar-muted">(optional)</span></span><ChevronDown size={16} className="text-stellar-muted transition-transform group-open:rotate-180" aria-hidden/></summary><div className="mt-3 divide-y divide-stellar-border">{sources.map(source=><label key={source.id} className={clsx('flex items-center gap-3 py-3',source.reason?'cursor-not-allowed opacity-60':'cursor-pointer')}><input type="checkbox" className="h-4 w-4 accent-[var(--color-stellar-blue)]" checked={!excluded.includes(source.id)&&!source.reason} disabled={!!source.reason} onChange={e=>{setExcluded(old=>e.target.checked?old.filter(id=>id!==source.id):[...old,source.id]);setQuote(null);}}/><span className="flex-1"><span className="block text-sm font-medium">{formatUnits(source.available,source.asset.scale)} {source.asset.code}</span><span className="block text-xs text-stellar-muted">{chainLabel(source.asset.chain)}{source.reason?` · ${sourceReason(source.reason)}`:''}</span></span></label>)}</div></details>}
      {!payment&&!execution&&<button className="ui-btn-primary w-full" disabled={busy||availability?.paused} onClick={()=>void getQuote()}>{busy?<Loader2 size={16} className="animate-spin" aria-hidden/>:<Sparkles size={16} aria-hidden/>}Find payment options</button>}
      {payment&&<div className="space-y-4">
        <div><h3 className="text-sm font-semibold">How you’ll pay</h3><p className="mt-0.5 text-sm text-stellar-muted">We’ll combine and convert the funds below automatically.</p></div>
        <ul className="divide-y divide-stellar-border overflow-hidden rounded-xl border border-stellar-border" aria-label="Payment breakdown">{payment.allocations.map((leg,i)=><li key={i} className="flex items-start justify-between gap-4 px-4 py-3">
          <span className="min-w-0"><span className="block text-sm font-medium">{leg.route.source.asset.code}</span><span className="block text-xs text-stellar-muted">from {chainLabel(leg.route.source.asset.chain)}</span></span>
          <span className="text-right"><span className="block text-sm font-medium tabular-nums">{formatUnits(leg.maxDebit,leg.route.source.asset.scale)} {leg.route.source.asset.code}</span>{leg.route.networkFee&&<span className="block text-xs text-stellar-muted">+ up to {formatUnits(leg.route.networkFee.amount,leg.route.networkFee.asset.scale)} {leg.route.networkFee.asset.code} network fee</span>}</span>
        </li>)}
        <li className="flex items-center justify-between gap-4 bg-stellar-dark/60 px-4 py-3"><span className="text-sm font-semibold">Total funding cost</span><span className="text-right text-sm font-semibold tabular-nums">{formatUnits(payment.cost,payment.invoice.asset.scale+12)} {payment.invoice.asset.code} <span className="font-normal text-stellar-muted">equivalent</span></span></li></ul>
        <p className="flex items-start gap-2 text-xs text-stellar-muted"><ShieldCheck size={14} className="mt-px shrink-0" aria-hidden/>Includes the network fee limits above. Network reserves remain protected.</p>
        {payment.simulated&&<p role="status" className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"><FlaskConical size={16} className="mt-0.5 shrink-0" aria-hidden/>Demonstration conversion · simulated rates and settlement.</p>}
        {!execution&&<>
          <p className={clsx('flex items-center gap-2 text-sm',quoteExpired?'text-red-500':'text-stellar-muted')}><Clock size={14} aria-hidden/>{quoteExpired?'This quote has expired. Refresh it to continue.':<>Quote expires at {new Date(payment.expiresAt).toLocaleTimeString()} <span className="tabular-nums">({countdown(Date.parse(payment.expiresAt)-now)} left)</span></>}</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]"><button className="ui-btn-primary" disabled={busy||availability?.paused||Date.parse(payment.expiresAt)<=Date.now()} onClick={()=>void approve()}>{busy?<Loader2 size={16} className="animate-spin" aria-hidden/>:<BadgeCheck size={16} aria-hidden/>}Approve & pay</button><button className="ui-btn-secondary" disabled={busy} onClick={()=>void getQuote()}><RefreshCw size={16} aria-hidden/>Refresh quote</button></div>
        </>}
      </div>}
      {execution&&status&&<div className="space-y-4">
        <div role="status" className={clsx('flex items-center gap-3 rounded-xl p-4',TONE_CLASSES[status.tone])}>
          {status.tone==='success'?<CheckCircle2 size={22} aria-hidden/>:status.tone==='warning'||status.tone==='danger'?<AlertTriangle size={22} aria-hidden/>:status.tone==='progress'?<Loader2 size={22} className="animate-spin" aria-hidden/>:<Wallet size={22} aria-hidden/>}
          <span className="font-semibold">{status.label}</span>
        </div>
        {execution.error&&['failed','recovery'].includes(execution.state)&&<p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">{paymentErrorText({code:execution.error})}</p>}
        <ul className="space-y-2" aria-label="Funding steps">{execution.legs.map(leg=>{const s=legStatus(leg.state);return <li key={leg.id} className="flex items-center justify-between gap-3 text-sm"><span>{formatUnits(leg.maxDebit,leg.route.source.asset.scale)} {leg.route.source.asset.code} <span className="text-stellar-muted">from {chainLabel(leg.route.source.asset.chain)}</span></span><StatusChip tone={s.tone}>{s.label}</StatusChip></li>;})}</ul>
      {execution.legs.map(leg=>leg.state==='prepared'&&leg.prepared?.chain&&<form key={leg.id} onSubmit={e=>{e.preventDefault();void sign(leg.id);}} className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="flex items-start gap-2 text-sm"><KeyRound size={16} className="mt-0.5 shrink-0 text-amber-500" aria-hidden/><span>Unlock {chainLabel(leg.route.source.asset.chain)} funding · <span className="font-semibold">{formatUnits(leg.maxDebit,leg.route.source.asset.scale)} {leg.route.source.asset.code}</span></span></p>
        <div><label htmlFor={`passphrase-${leg.id}`} className="ui-label">Local wallet passphrase</label><input id={`passphrase-${leg.id}`} required type="password" autoComplete="off" className="ui-field" value={passphrases[leg.id]??''} onChange={e=>setPassphrases(p=>({...p,[leg.id]:e.target.value}))}/><p className="mt-1.5 text-xs text-stellar-muted">Your key is unlocked and used on this device only. It is never sent to Amma.</p></div>
        <button className="ui-btn-primary w-full" disabled={busy}>{busy?<Loader2 size={16} className="animate-spin" aria-hidden/>:<PenLine size={16} aria-hidden/>}Sign approved funding</button>
      </form>)}
      {execution.state==='recovery'&&<button className="ui-btn-primary w-full" disabled={busy} onClick={()=>void work(async()=>{setExecution(await paymentRequest(`/executions/${execution.id}/recover`,{}));})}><Undo2 size={16} aria-hidden/>Return available funds to Amma balance</button>}
      {execution.receipt&&<div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm"><p className="flex items-center gap-2 font-medium"><ReceiptText size={16} className="text-emerald-500" aria-hidden/>Receipt</p><dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs"><dt className="text-stellar-muted">Receipt</dt><dd className="break-all font-mono">{String(execution.receipt.id)}</dd><dt className="text-stellar-muted">Reference</dt><dd className="break-all font-mono">{String(execution.receipt.reference)}</dd></dl></div>}
      {['paid','recovered'].includes(execution.state)&&<Link to="/payments" onClick={()=>{setExecution(null);setInvoice(null);setQuote(null);setLink('');}} className="ui-btn-secondary w-full">Make another payment</Link>}
      </div>}
      </div>
    </section>}
    {history.length>0&&<section aria-labelledby="recent-heading" className="space-y-3"><h2 id="recent-heading" className="text-lg font-semibold">Recent payments</h2><ul className="ui-card divide-y divide-stellar-border overflow-hidden">{history.map(item=>{const s=executionStatus(item.state);const inv=item.quote.invoice;return <li key={item.id}><Link className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-stellar-text/5" to={`/payments?execution=${item.id}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-stellar-blue/15 text-stellar-purple"><Store size={16} aria-hidden/></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{inv.merchant}</span><span className="block text-xs text-stellar-muted">{formatUnits(inv.amount,inv.asset.scale)} {inv.asset.code}</span></span>
      <StatusChip tone={s.tone}>{executionShortLabel(item.state)}</StatusChip>
      <ChevronRight size={16} className="shrink-0 text-stellar-muted" aria-hidden/>
    </Link></li>;})}</ul></section>}
    </main>
  </div>;
}

function countdown(ms:number){const s=Math.max(0,Math.floor(ms/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
