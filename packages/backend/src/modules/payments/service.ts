import { assetKey,assetEnvironment, canonical, digest, newId, requireThat, units, uuid, PaymentFault,
  type Asset, type Execution, type FundingAdapter, type Invoice, type Quote, type PaymentRail, type Leg } from './domain';
import { planFunding } from './planner';
import { PaymentStore, type Session } from './store';
import {maxPaymentUnits,maxDailyUnits} from './configuration';

export class PaymentService {
  constructor(public store: PaymentStore, public adapters: FundingAdapter[], private rail: PaymentRail,
    private canSubmit: () => boolean = () => false) {}
  async idempotent<T extends {id: string}>(owner: number, operation: string, key: string, body: unknown,
    kind: string, work: (tx: Session, id: string) => Promise<T>): Promise<T> {
    uuid(key); const bodyHash=digest(body), id=newId();
    return this.store.db.transaction(async tx => {
      await tx.query(`INSERT INTO payment_idempotency(owner_id,operation,key,digest,result_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[owner,operation,key,bodyHash,id]);
      const [record]=await tx.query('SELECT * FROM payment_idempotency WHERE owner_id=$1 AND operation=$2 AND key=$3 FOR UPDATE',[owner,operation,key]);
      requireThat(record.digest===bodyHash,'IDEMPOTENCY_CONFLICT',409);
      if(record.result_id!==id) return this.store.get<T>(tx,kind,record.result_id,owner);
      return work(tx,id);
    });
  }
  async invoice(owner: number, key: string, data: {merchant: string; asset: Asset; amount: string; reference: string; walletAddress?: string; incomingPayment?: string}) {
    units(data.amount); assetKey(data.asset);
    requireThat(units(data.amount)<=units(maxPaymentUnits()),'PAYMENT_LIMIT_EXCEEDED',409);
    requireThat(data.merchant.length>0 && data.merchant.length<=100 && data.reference.length<=100,'INVALID_INVOICE');
    if(data.walletAddress) {
      const mapping=await this.store.db.query('SELECT * FROM payment_wallet_addresses WHERE url=$1 AND owner_id=$2 AND asset_key=$3',[data.walletAddress,owner,assetKey(data.asset)]);
      requireThat(mapping.length,'WALLET_ADDRESS_NOT_OWNED',403);
    }
    return this.idempotent(owner,'invoice',key,data,'invoice',async(tx,id)=>{
      const invoice: Invoice={...data,id,owner,expiresAt:new Date(Date.now()+30*60_000).toISOString()};
      await this.store.put(tx,'invoice',id,owner,invoice); return invoice;
    });
  }
  async sources(owner: number) {
    const results=await Promise.all(this.adapters.map(async a=>{
      try{return await a.sources(owner);}catch{return [];} // A failed source is never fabricated as spendable.
    })); return results.flat();
  }
  async quote(owner: number, invoiceId: string, key: string, excluded: string[]=[]) {
    const invoice=await this.store.get<Invoice>(this.store.db,'invoice',uuid(invoiceId));
    requireThat(units(invoice.amount)<=units(maxPaymentUnits()),'PAYMENT_LIMIT_EXCEEDED',409);
    requireThat(Date.parse(invoice.expiresAt)>Date.now(),'INVOICE_EXPIRED',409);
    const rail=await this.rail.quote(invoice), sources=await this.sources(owner);
    const routes=(await Promise.all(sources.filter(s=>!excluded.includes(s.id)&&!s.reason&&assetEnvironment(s.asset)===assetEnvironment(invoice.asset)).map(async s=>{
      const adapter=this.adapters.find(a=>a.id===s.adapter)!;
      try {return await adapter.routes(s,invoice.asset,rail.debit);}catch{return [];}
    }))).flat();
    const plan=planFunding(rail.debit,routes,excluded);
    plan.expiresAt=new Date(Math.min(Date.parse(plan.expiresAt),Date.parse(rail.expiresAt),Date.parse(invoice.expiresAt))).toISOString();
    return this.idempotent(owner,'quote',key,{invoiceId,excluded},'quote',async(tx,id)=>{
      const snapshot={...plan,id,owner,invoice,rail:rail.data,createdAt:new Date().toISOString()};
      const quote: Quote={...snapshot,hash:digest(snapshot)};
      await this.store.put(tx,'quote',id,owner,quote); return quote;
    });
  }
  async approve(owner: number, quoteId: string, hash: string, key: string) {
    requireThat(this.canSubmit(),'PAYMENTS_PAUSED',503);
    return this.idempotent(owner,'approve',key,{quoteId,hash},'execution',async(tx,id)=>{
      const quote=await this.store.get<Quote>(tx,'quote',uuid(quoteId),owner,true);
      requireThat(quote.hash===hash,'APPROVAL_MISMATCH',409);
      requireThat(Date.parse(quote.expiresAt)>Date.now(),'QUOTE_EXPIRED',409);
      // A quote can be approved once, even with a fresh HTTP idempotency key.
      const used=await tx.query("SELECT id FROM payment_documents WHERE kind='execution' AND body->'quote'->>'id'=$1",[quoteId]);
      requireThat(!used.length,'QUOTE_ALREADY_APPROVED',409);
      const claimed=await tx.query('INSERT INTO payment_invoice_claims(invoice_id,execution_id,owner_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING invoice_id',[quote.invoice.id,id,owner]);
      requireThat(claimed.length,'INVOICE_ALREADY_IN_PROGRESS',409);
      const limit=await tx.query(`INSERT INTO payment_spend_limits(owner_id,asset_key,day,committed) VALUES($1,$2,CURRENT_DATE,$3)
        ON CONFLICT(owner_id,asset_key,day) DO UPDATE SET committed=payment_spend_limits.committed+excluded.committed
        WHERE payment_spend_limits.committed+excluded.committed<=$4::numeric RETURNING owner_id`,[owner,assetKey(quote.invoice.asset),quote.receive,maxDailyUnits()]);
      requireThat(limit.length&&units(quote.receive)<=units(maxDailyUnits()),'DAILY_PAYMENT_LIMIT_EXCEEDED',409);
      const execution: Execution={id,owner,quote,state:'funding',createdAt:new Date().toISOString(),
        legs:quote.allocations.map(a=>({...a,id:newId(),state:'planned'}))};
      for(const leg of execution.legs) if(leg.route.source.accountId) {
        const [account]=await tx.query("SELECT id FROM payment_accounts WHERE id=$1 AND owner_id=$2 AND kind='customer'",[leg.route.source.accountId,owner]);
        requireThat(account,'SOURCE_NOT_OWNED',403);
        const hold=await this.store.account(tx,owner,leg.route.source.asset,'reserved',leg.id);
        await this.store.transfer(tx,account.id,hold,leg.route.source.asset,leg.maxDebit,`${id}:${leg.id}:reserve`);
      }
      await this.store.put(tx,'execution',id,owner,execution);
      await this.store.enqueue(tx,id,owner,'execution',{id}); return execution;
    });
  }
  get(owner: number,id: string) { return this.store.get<Execution>(this.store.db,'execution',uuid(id),owner); }
  private async save(execution: Execution) { await this.store.put(this.store.db,'execution',execution.id,execution.owner,execution); }
  private adapter(leg: Leg) {
    const adapter=this.adapters.find(a=>a.id===leg.route.source.adapter);
    requireThat(adapter,'ADAPTER_UNAVAILABLE',503);return adapter;
  }
  async signature(owner: number,id: string,legId: string,signature: unknown) {
    requireThat(this.canSubmit(),'PAYMENTS_PAUSED',503);
    return this.store.db.transaction(async tx=>{
    await tx.query('SELECT id FROM payment_jobs WHERE id=$1 FOR UPDATE',[uuid(id)]);
    const execution=await this.get(owner,id), leg=execution.legs.find(l=>l.id===uuid(legId));
    requireThat(leg && execution.state==='funding' && ['prepared','submitted'].includes(leg.state),'FUNDING_NOT_READY',409);
    // Adapter persists the exact signed transaction before broadcast. A timeout
    // leaves that attempt unresolved; retries can only submit the identical blob.
    await this.adapter(leg).submit(owner,leg,signature);
    leg.state='submitted';await this.save(execution);
    return this.get(owner,id);
    });
  }
  async recover(owner: number,id: string) {
    return this.store.db.transaction(async tx=>{
      // Same lock the worker holds while advancing this execution, so a recovery
      // can never interleave with a funding confirmation or rail observation.
      await tx.query('SELECT id FROM payment_jobs WHERE id=$1 FOR UPDATE',[uuid(id)]);
      const execution=await this.store.get<Execution>(tx,'execution',uuid(id),owner,true);
      requireThat(execution.state==='recovery','RECOVERY_NOT_AVAILABLE',409);
      requireThat(execution.legs.every(l=>['confirmed','failed','planned'].includes(l.state)),'FUNDING_UNRESOLVED',409);
      requireThat(!execution.outgoing || execution.outgoing.definitivelyFailed===true,'PAYMENT_UNRESOLVED',409);
      for(const leg of execution.legs) if(leg.route.source.accountId && leg.state!=='confirmed') {
        const hold=await this.store.account(tx,owner,leg.route.source.asset,'reserved',leg.id);
        await this.store.transfer(tx,hold,leg.route.source.accountId,leg.route.source.asset,leg.maxDebit,`${id}:${leg.id}:release`);
      }
      const targetHold=await this.store.account(tx,owner,execution.quote.invoice.asset,'reserved',id);
      const [held]=await tx.query('SELECT balance::text FROM payment_accounts WHERE id=$1',[targetHold]);
      if(units(held.balance,true)>0n) {
        const available=await this.store.account(tx,owner,execution.quote.invoice.asset);
        await this.store.transfer(tx,targetHold,available,execution.quote.invoice.asset,held.balance,`${id}:recovery`);
      }
      execution.state='recovered';await this.store.put(tx,'execution',id,owner,execution);
      await tx.query('DELETE FROM payment_invoice_claims WHERE execution_id=$1',[id]);return execution;
    });
  }
  /** Called under a durable job row lock. Network operations use stable IDs;
   * uncertain observations remain pending and never start replacement payments. */
  async advance(owner: number,id: string) {
    let execution=await this.get(owner,id);
    if(['paid','recovered'].includes(execution.state)) return execution;
    if(execution.state==='recovery'&&execution.legs.every(l=>['confirmed','failed','planned'].includes(l.state)))return execution;
    const pendingWallets=new Set<string>();
    for(const leg of execution.legs) {
      if(leg.state==='confirmed'||leg.state==='failed') continue;
      const walletKey=leg.route.source.walletId?`${leg.route.source.asset.chain}:${leg.route.source.asset.network}:${leg.route.source.walletId}`:null;
      if(walletKey&&pendingWallets.has(walletKey))continue;
      if(leg.state==='planned') {
        if(execution.state==='recovery')continue;
        if(!this.canSubmit()) return execution;
        if(Date.now()-Date.parse(execution.createdAt)>10*60_000) {execution.state='recovery';execution.error='APPROVAL_EXPIRED';await this.save(execution);return execution;}
        try{leg.prepared=await this.adapter(leg).prepare(owner,execution,leg);}
        catch(error){
          if(error instanceof PaymentFault&&['FUNDING_QUOTE_CHANGED','PARTNER_QUOTE_CHANGED'].includes(error.code)){
            leg.state='failed';execution.state='recovery';execution.error=error.code;await this.save(execution);return execution;
          }throw error;
        }
        leg.state='prepared';await this.save(execution);
      }
      const observation=await this.adapter(leg).observe(owner,leg);
      leg.observation=observation;
      if(observation.state==='confirmed') {
        requireThat(observation.received===leg.receive && observation.assetKey===assetKey(execution.quote.invoice.asset),'FUNDING_EVIDENCE_MISMATCH',409);
        await this.store.db.transaction(async tx=>{
          const target=execution.quote.invoice.asset, targetHold=await this.store.account(tx,owner,target,'reserved',id);
          if(leg.route.source.accountId) {
            const sourceHold=await this.store.account(tx,owner,leg.route.source.asset,'reserved',leg.id);
            const clearing=await this.store.account(tx,0,leg.route.source.asset,'clearing');
            const unused=units(String(observation.evidence?.sourceUnused??'0'),true);requireThat(unused<=units(leg.maxDebit),'INVALID_SOURCE_REMAINDER',409);
            const consumed=units(leg.maxDebit)-unused;
            if(consumed>0n)await this.store.transfer(tx,sourceHold,clearing,leg.route.source.asset,consumed.toString(),`${id}:${leg.id}:consume`);
            if(unused>0n)await this.store.transfer(tx,sourceHold,leg.route.source.accountId,leg.route.source.asset,unused.toString(),`${id}:${leg.id}:unused`);
          }else if(observation.evidence?.sourceUnused){
            const unused=units(String(observation.evidence.sourceUnused),true);requireThat(unused<=units(leg.maxDebit),'INVALID_SOURCE_REMAINDER',409);
            if(unused>0n){const customer=await this.store.account(tx,owner,leg.route.source.asset),clearing=await this.store.account(tx,0,leg.route.source.asset,'clearing');
              await this.store.transfer(tx,clearing,customer,leg.route.source.asset,unused.toString(),`${id}:${leg.id}:unused`);}
          }
          const clearing=await this.store.account(tx,0,target,'clearing');
          await this.store.transfer(tx,clearing,targetHold,target,leg.receive,`${id}:${leg.id}:confirmed`);
          leg.state='confirmed';await this.store.put(tx,'execution',id,owner,execution);
        });
      } else if(observation.state==='failed') { leg.state='failed';execution.state='recovery';await this.save(execution);return execution; }
      else {leg.state=observation.state==='unknown'?'unknown':observation.evidence?.requiresSignature===true?'prepared':'submitted';await this.save(execution);}
      if(walletKey&&observation.state!=='confirmed')pendingWallets.add(walletKey);
    }
    if(execution.state==='recovery'||!execution.legs.every(l=>l.state==='confirmed'))return execution;
    execution.state=execution.outgoing?'paying':'ready';await this.save(execution);
    if(!execution.outgoing) {
      if(!this.canSubmit())return execution;
      if(Date.parse(execution.quote.expiresAt)<=Date.now()){
        const refreshed=await this.rail.quote(execution.quote.invoice);
        if(units(refreshed.debit)>units(execution.quote.receive)||Date.now()-Date.parse(execution.createdAt)>10*60_000){execution.state='recovery';execution.error='QUOTE_EXCEEDS_APPROVAL';await this.save(execution);return execution;}
        execution.quote.rail=refreshed.data;execution.quote.expiresAt=refreshed.expiresAt;await this.save(execution);
      }
      // Mark the irreversible boundary before calling the rail. On an ambiguous
      // create response the rail must reconcile using the persisted client ID.
      execution.state='paying';execution.outgoing={clientReference:id};await this.save(execution);
      execution.outgoing={...execution.outgoing,...await this.rail.prepare(execution)};await this.save(execution);
    }
    const observed=await this.rail.observe(execution);
    if(observed.state==='confirmed') {
      requireThat(observed.received===execution.quote.invoice.amount && observed.assetKey===assetKey(execution.quote.invoice.asset),'RECIPIENT_UNDERPAID',409);
      await this.store.db.transaction(async tx=>{
        execution=await this.store.get<Execution>(tx,'execution',id,owner,true);
        if(execution.state==='paid')return;
        const asset=execution.quote.invoice.asset, hold=await this.store.account(tx,owner,asset,'reserved',id), clearing=await this.store.account(tx,0,asset,'clearing');
        const unused=String(observed.evidence?.unused??'0'),spent=units(execution.quote.receive)-units(unused,true);requireThat(spent>=0n,'INVALID_UNUSED_LIQUIDITY',409);
        if(spent>0n)await this.store.transfer(tx,hold,clearing,asset,spent.toString(),`${id}:paid`);
        if(units(unused,true)>0n){const customer=await this.store.account(tx,owner,asset);await this.store.transfer(tx,hold,customer,asset,unused,`${id}:unused`);}
        execution.state='paid';execution.receipt={id,recipient:execution.quote.invoice.walletAddress??execution.quote.invoice.merchant,
          asset,received:observed.received,reference:observed.reference,simulated:execution.quote.simulated,completedAt:new Date().toISOString()};
        await this.store.put(tx,'execution',id,owner,execution);
      });
    }else if(observed.state==='failed') {
      // Failure does not imply that every approved unit is still backed. The
      // rail reports the amount actually withdrawn plus any unfunded remainder.
      requireThat(typeof observed.evidence?.unused==='string','REFUND_EVIDENCE_REQUIRED',409);
      const refundable=units(observed.evidence.unused,true);
      const consumed=units(execution.quote.receive)-refundable;
      requireThat(consumed>=0n,'INVALID_UNUSED_LIQUIDITY',409);
      await this.store.db.transaction(async tx=>{
        const asset=execution.quote.invoice.asset;
        if(consumed>0n){const hold=await this.store.account(tx,owner,asset,'reserved',id),clearing=await this.store.account(tx,0,asset,'clearing');
          await this.store.transfer(tx,hold,clearing,asset,consumed.toString(),`${id}:failed-charge`);}
        execution.state='recovery';execution.outgoing!.definitivelyFailed=true;
        await this.store.put(tx,'execution',id,owner,execution);
      });
    }
    return execution;
  }
  async tick() {
    // Lock survives the network calls: one worker per job, including across
    // processes. Short adapter deadlines bound the transaction duration.
    const jobs=await this.store.db.query("SELECT id FROM payment_jobs WHERE kind='execution' AND state='pending' AND next_attempt<=now() ORDER BY created_at LIMIT 10");
    for(const job of jobs) await this.store.db.transaction(async tx=>{
      const [locked]=await tx.query("SELECT * FROM payment_jobs WHERE id=$1 AND state='pending' FOR UPDATE SKIP LOCKED",[job.id]);
      if(!locked)return;
      try {
        const state=(await this.advance(Number(locked.owner_id),locked.id)).state;
        const current=await this.get(Number(locked.owner_id),locked.id);
        const stopped=['paid','recovered'].includes(state)||(state==='recovery'&&current.legs.every(l=>['confirmed','failed','planned'].includes(l.state)));
        await tx.query("UPDATE payment_jobs SET state=$2,attempts=attempts+1,next_attempt=now()+interval '5 seconds' WHERE id=$1",[job.id,stopped?'done':'pending']);
      }catch(error) {
        const code=error instanceof PaymentFault?error.code:'ADAPTER_UNAVAILABLE';
        const review=['FUNDING_EVIDENCE_MISMATCH','OUTGOING_EVIDENCE_MISMATCH','RECIPIENT_ASSET_MISMATCH','RECIPIENT_UNDERPAID','LEDGER_REFERENCE_CONFLICT','REFUND_EVIDENCE_REQUIRED','INVALID_UNUSED_LIQUIDITY'].includes(code);
        await tx.query("UPDATE payment_jobs SET state=$3,attempts=attempts+1,last_error=$2,next_attempt=now()+interval '15 seconds' WHERE id=$1",[job.id,code,review?'review':'pending']);
      }
    });
  }
}
