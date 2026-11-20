import { assetKey, digest, requireThat, units,PaymentFault, type Asset } from './domain';
import {maxPaymentUnits,maxDailyUnits} from './configuration';
import { PaymentStore } from './store';
import { RafikiAdmin } from './rafiki';

/** Webhooks are wake-ups only. Money is posted from authoritative Admin reads. */
export class ProviderEvents {
  constructor(private store:PaymentStore,private admin:RafikiAdmin,private canFund:()=>boolean) {}
  async handle(event:any) {
    const id=String(event.data?.id??'').split('/').pop();requireThat(id,'INVALID_WEBHOOK_RESOURCE');
    if(['incoming_payment.completed','incoming_payment.expired'].includes(event.type))return this.incoming(id!);
    if(event.type==='outgoing_payment.created')return this.outgoing(id!);
    if(['outgoing_payment.completed','outgoing_payment.failed','outgoing_payment.cancelled'].includes(event.type))return this.finalize(id!);
    // Low-liquidity and unknown events remain durable for operations inspection.
  }
  private async incoming(id:string) {
    const data=await this.admin.call(`query Incoming($id:String!){incomingPayment(id:$id){id walletAddressId state receivedAmount{value assetCode assetScale}}}`,{id});
    const payment=data.incomingPayment;requireThat(payment&&['COMPLETED','EXPIRED'].includes(payment.state),'INCOMING_NOT_FINAL',409);
    const [account]=await this.store.db.query(`SELECT a.* FROM payment_accounts a JOIN payment_wallet_addresses w ON w.account_id=a.id WHERE w.rafiki_id=$1`,[payment.walletAddressId]);
    requireThat(account,'INCOMING_ACCOUNT_UNKNOWN',409);
    const asset=account.asset as Asset;
    requireThat(payment.receivedAmount.assetCode===asset.code&&payment.receivedAmount.assetScale===asset.scale,'INCOMING_ASSET_MISMATCH',409);
    if(units(payment.receivedAmount.value,true)===0n)return;
    const key=digest({incoming:id}).slice(0,32);
    await this.admin.call(`mutation Withdraw($input:CreateIncomingPaymentWithdrawalInput!){createIncomingPaymentWithdrawal(input:$input){success}}`,
      {input:{incomingPaymentId:id,idempotencyKey:key,timeoutSeconds:'0'}}).then(data=>requireThat(data.createIncomingPaymentWithdrawal.success,'WITHDRAWAL_UNCONFIRMED',503));
    await this.store.db.transaction(async tx=>{
      const clearing=await this.store.account(tx,0,asset,'clearing');
      await this.store.transfer(tx,clearing,account.id,asset,payment.receivedAmount.value,`incoming:${id}`);
    });
  }
  private async outgoing(id:string) {
    requireThat(this.canFund(),'PAYMENTS_PAUSED',503); // Retain the job until funding is resumed.
    const data=await this.admin.call(`query Outgoing($id:String!){outgoingPayment(id:$id){id walletAddressId state debitAmount{value assetCode assetScale}}}`,{id});
    const payment=data.outgoingPayment;requireThat(payment,'OUTGOING_NOT_FOUND',409);
    const [account]=await this.store.db.query(`SELECT a.* FROM payment_accounts a JOIN payment_wallet_addresses w ON w.account_id=a.id WHERE w.rafiki_id=$1`,[payment.walletAddressId]);
    if(!account)return; // Treasury checkout sends are funded by the orchestrator.
    const asset=account.asset as Asset;
    requireThat(payment.debitAmount.assetCode===asset.code&&payment.debitAmount.assetScale===asset.scale,'OUTGOING_ASSET_MISMATCH',409);
    if(payment.state!=='FUNDING')return;
    try{await this.store.db.transaction(async tx=>{
      const hold=await this.store.account(tx,Number(account.owner_id),asset,'reserved',`op:${id}`);
      const prior=await tx.query('SELECT id FROM payment_ledger WHERE reference=$1',[`outgoing:${id}:reserve`]);
      if(!prior.length){
        requireThat(units(payment.debitAmount.value)<=units(maxPaymentUnits()),'PAYMENT_LIMIT_EXCEEDED',409);
        const limited=await tx.query(`INSERT INTO payment_spend_limits(owner_id,asset_key,day,committed) VALUES($1,$2,CURRENT_DATE,$3)
          ON CONFLICT(owner_id,asset_key,day) DO UPDATE SET committed=payment_spend_limits.committed+excluded.committed
          WHERE payment_spend_limits.committed+excluded.committed<=$4::numeric RETURNING owner_id`,[account.owner_id,assetKey(asset),payment.debitAmount.value,maxDailyUnits()]);
        requireThat(limited.length&&units(payment.debitAmount.value)<=units(maxDailyUnits()),'DAILY_PAYMENT_LIMIT_EXCEEDED',409);
      }
      await this.store.transfer(tx,account.id,hold,asset,payment.debitAmount.value,`outgoing:${id}:reserve`);
      await this.store.enqueue(tx,id,Number(account.owner_id),'rafiki-outgoing',{id});
    });}catch(error){
      if(error instanceof PaymentFault&&['INSUFFICIENT_AVAILABLE_BALANCE','PAYMENT_LIMIT_EXCEEDED','DAILY_PAYMENT_LIMIT_EXCEEDED'].includes(error.code)){
        await this.admin.call(`mutation Cancel($input:CancelOutgoingPaymentInput!){cancelOutgoingPayment(input:$input){payment{id}}}`,
          {input:{id,reason:'Payment declined by account funding policy'}});return;
      }throw error;
    }
    await this.admin.fund(id,digest({outgoing:id}).slice(0,32));
  }
  private async finalize(id:string) {
    const data=await this.admin.call(`query Outgoing($id:String!){outgoingPayment(id:$id){id walletAddressId state liquidity debitAmount{value assetCode assetScale}}}`,{id});
    const payment=data.outgoingPayment;requireThat(payment&&['COMPLETED','FAILED','CANCELLED'].includes(payment.state),'OUTGOING_NOT_FINAL',409);
    const [account]=await this.store.db.query(`SELECT a.* FROM payment_accounts a JOIN payment_wallet_addresses w ON w.account_id=a.id WHERE w.rafiki_id=$1`,[payment.walletAddressId]);
    if(!account)return;
    const reserved=await this.store.db.query('SELECT id FROM payment_ledger WHERE reference=$1',[`outgoing:${id}:reserve`]);
    if(!reserved.length){requireThat(payment.state!=='COMPLETED','OUTGOING_RESERVATION_MISSING',409);return;}
    const asset=account.asset as Asset,owner=Number(account.owner_id);
    const [snapshot]=await this.store.db.query("SELECT body FROM payment_documents WHERE kind='op-finalize' AND id=$1",[id]);
    // In this pinned Rafiki release cancellation is allowed only in FUNDING,
    // before the liquidity account exists. Its whole reservation is unspent.
    const remaining=snapshot?.body.remaining??(payment.state==='CANCELLED'?payment.debitAmount.value:String(payment.liquidity));
    requireThat(units(remaining,true)<=units(payment.debitAmount.value),'INVALID_REMAINING_LIQUIDITY',409);
    await this.store.put(this.store.db,'op-finalize',id,owner,{remaining});
    if(payment.state!=='CANCELLED')await this.admin.call(`mutation Withdraw($input:CreateOutgoingPaymentWithdrawalInput!){createOutgoingPaymentWithdrawal(input:$input){success}}`,
      {input:{outgoingPaymentId:id,idempotencyKey:digest({withdraw:id}).slice(0,32),timeoutSeconds:'0'}})
      .then(data=>requireThat(data.createOutgoingPaymentWithdrawal.success,'WITHDRAWAL_UNCONFIRMED',503));
    await this.store.db.transaction(async tx=>{
      const hold=await this.store.account(tx,owner,asset,'reserved',`op:${id}`),clearing=await this.store.account(tx,0,asset,'clearing');
      const spent=units(payment.debitAmount.value)-units(remaining,true);
      if(spent>0n)await this.store.transfer(tx,hold,clearing,asset,spent.toString(),`outgoing:${id}:spent`);
      if(units(remaining,true)>0n)await this.store.transfer(tx,hold,account.id,asset,remaining,`outgoing:${id}:return`);
    });
  }
  private async reconcileOutgoing(id:string){
    const data=await this.admin.call(`query OutgoingState($id:String!){outgoingPayment(id:$id){id state}}`,{id});
    requireThat(data.outgoingPayment,'OUTGOING_NOT_FOUND',409);
    if(['COMPLETED','FAILED','CANCELLED'].includes(data.outgoingPayment.state)){await this.finalize(id);return true;}
    if(data.outgoingPayment.state==='FUNDING'&&this.canFund())await this.outgoing(id);
    return false;
  }
  /** Lost webhooks: queue provider payments on Amma wallet addresses that no job or posting covers yet.
   *  Only queues; the job loop still reads authoritative state before any money moves. */
  async catchUp(now=new Date(),lookbackMs=Number(process.env.PAYMENTS_CATCHUP_LOOKBACK_MS??7*24*3600_000)) {
    const since=now.getTime()-lookbackMs,maxPages=20;
    const wallets=await this.store.db.query('SELECT rafiki_id,owner_id FROM payment_wallet_addresses ORDER BY rafiki_id');
    const owners=new Map<string,number>(wallets.map((w:any)=>[w.rafiki_id,Number(w.owner_id)]));
    for(const wallet of wallets){
      let after:string|undefined;
      for(let page=0;page<maxPages;page++){
        const data=await this.admin.call(`query CatchUpIncoming($id:String!,$after:String){walletAddress(id:$id){incomingPayments(first:50,after:$after,sortOrder:DESC){edges{node{id state createdAt receivedAmount{value}}} pageInfo{hasNextPage endCursor}}}}`,{id:wallet.rafiki_id,after});
        const connection=data.walletAddress?.incomingPayments;if(!connection)break;
        let older=false;
        for(const {node} of connection.edges){
          if(Date.parse(node.createdAt)<since){older=true;break;}
          if(!['COMPLETED','EXPIRED'].includes(node.state)||units(node.receivedAmount.value,true)===0n)continue;
          const posted=await this.store.db.query('SELECT id FROM payment_ledger WHERE reference=$1',[`incoming:${node.id}`]);
          if(!posted.length)await this.store.enqueue(this.store.db,node.id,owners.get(wallet.rafiki_id)!,'rafiki-incoming',{id:node.id});
        }
        if(older||!connection.pageInfo.hasNextPage)break;after=connection.pageInfo.endCursor;
      }
    }
    if(!this.canFund())return; // Unfunded outgoing payments wait (and expire at the provider) while paused.
    for(let i=0;i<wallets.length;i+=100){
      const ids=wallets.slice(i,i+100).map((w:any)=>w.rafiki_id);let after:string|undefined;
      for(let page=0;page<maxPages;page++){
        const data=await this.admin.call(`query CatchUpOutgoing($filter:OutgoingPaymentFilter,$after:String){outgoingPayments(first:50,after:$after,sortOrder:DESC,filter:$filter){edges{node{id walletAddressId state createdAt}} pageInfo{hasNextPage endCursor}}}`,
          {filter:{walletAddressId:{in:ids},state:{in:['FUNDING']}},after});
        const connection=data.outgoingPayments;
        for(const {node} of connection.edges)if(Date.parse(node.createdAt)>=since&&owners.has(node.walletAddressId))
          await this.store.enqueue(this.store.db,node.id,owners.get(node.walletAddressId)!,'rafiki-outgoing',{id:node.id});
        if(!connection.pageInfo.hasNextPage)break;after=connection.pageInfo.endCursor;
      }
    }
  }
  async tick() {
    const jobs=await this.store.db.query("SELECT id FROM payment_jobs WHERE kind IN ('rafiki-webhook','rafiki-outgoing','rafiki-incoming') AND state='pending' AND next_attempt<=now() ORDER BY created_at LIMIT 10");
    for(const job of jobs)await this.store.db.transaction(async tx=>{
      const [locked]=await tx.query("SELECT * FROM payment_jobs WHERE id=$1 AND state='pending' FOR UPDATE SKIP LOCKED",[job.id]);if(!locked)return;
      try{
        let done=true;
        if(locked.kind==='rafiki-outgoing')done=await this.reconcileOutgoing(locked.body.id);
        else if(locked.kind==='rafiki-incoming')await this.incoming(locked.body.id);
        else await this.handle(locked.body);
        await tx.query("UPDATE payment_jobs SET state=$2,attempts=attempts+1,next_attempt=now()+interval '5 seconds' WHERE id=$1",[job.id,done?'done':'pending']);
      }
      catch{await tx.query("UPDATE payment_jobs SET attempts=attempts+1,last_error='PROVIDER_RECONCILIATION_PENDING',next_attempt=now()+interval '15 seconds' WHERE id=$1",[job.id]);}
    });
  }
}
