import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAuthenticatedClient, createUnauthenticatedClient, isFinalizedGrantWithAccessToken, type AuthenticatedClient } from '@interledger/open-payments';
import { assetKey, canonical, digest, requireThat, units, PaymentFault, type Asset, type Execution, type Invoice, type Observation, type PaymentRail } from './domain';
import { PaymentStore } from './store';
import {internalRafikiUrlAllowed,maxPaymentUnits} from './configuration';

export function signature(secret: string,body: unknown,timestamp=Date.now()):string {
  return `t=${timestamp}, v1=${createHmac('sha256',secret).update(`${timestamp}.${canonical(body)}`).digest('hex')}`;
}
export function verifyWebhook(secret:string,header:unknown,body:unknown,now=Date.now()):boolean {
  if(secret.length<32||typeof header!=='string')return false;
  const match=/^t=(\d{10,16}),\s*v1=([0-9a-f]{64})$/.exec(header);
  if(!match)return false;
  const timestamp=Number(match[1]);
  if(!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp)>30_000)return false;
  return timingSafeEqual(Buffer.from(match[2],'hex'),Buffer.from(signature(secret,body,timestamp).split('v1=')[1],'hex'));
}
export class RafikiAdmin {
  constructor(private url:string,private tenant:string,private secret:string) {
    requireThat(secret.length>=32,'RAFIKI_SECRET_TOO_SHORT');
    requireThat(internalRafikiUrlAllowed(url),'INVALID_RAFIKI_URL');
  }
  async call<T=any>(query:string,variables:Record<string,unknown>):Promise<T> {
    const body={query,variables};
    const response=await fetch(this.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
      headers:{'Content-Type':'application/json','tenant-id':this.tenant,signature:signature(this.secret,body)},body:canonical(body)});
    requireThat(response.ok,'RAFIKI_ADMIN_UNAVAILABLE',503);
    const result=await response.json() as {data:T;errors?:unknown[]};
    const errors=(result.errors??[]) as {extensions?:{code?:string}}[];
    // BAD_USER_INPUT is Rafiki's definitive refusal (e.g. "invalid quote"); callers
    // may act on it. Anything else stays a retryable availability failure.
    requireThat(!errors.length||!errors.every(e=>e?.extensions?.code==='BAD_USER_INPUT'),'RAFIKI_INPUT_REJECTED',409);
    requireThat(!errors.length||!errors.every(e=>e?.extensions?.code==='NOT_FOUND'),'RAFIKI_NOT_FOUND',404);
    requireThat(!errors.length&&result.data,'RAFIKI_OPERATION_FAILED',503);return result.data;
  }
  async fund(id:string,key:string) {
    const result=await this.call(`mutation Fund($input: DepositOutgoingPaymentLiquidityInput!){depositOutgoingPaymentLiquidity(input:$input){success}}`,{input:{outgoingPaymentId:id,idempotencyKey:key}});
    requireThat(result.depositOutgoingPaymentLiquidity.success,'RAFIKI_FUNDING_FAILED',503);
  }
}
// Pinned Rafiki QUOTE_LIFESPAN (5 min) plus slack. Amma's quote expiry is never
// earlier than the Rafiki quote's creation, so past this margin Rafiki can no
// longer create an outgoing payment from that quote.
const RAFIKI_QUOTE_LIFESPAN_MS=5*60_000+30_000;
export type RafikiAsset = {asset:Asset;assetId:string;senderId:string;senderUrl:string};
export class RafikiRail implements PaymentRail {
  private client:Promise<AuthenticatedClient>;
  constructor(private store:PaymentStore,public admin:RafikiAdmin,private assets:RafikiAsset[],
    walletAddressUrl:string,keyId:string,privateKey:string,private allowedOrigins:string[],private canFund:()=>boolean=()=>false) {
    this.assertUrl(walletAddressUrl);
    this.client=createAuthenticatedClient({walletAddressUrl,keyId,privateKey,requestTimeoutMs:10_000,logLevel:'silent'});
    // Startup explicitly awaits ready(); this catch also prevents an unhandled
    // rejection if construction is followed by another configuration failure.
    void this.client.catch(()=>{});
  }
  async ready(){await this.client;}
  assertUrl(value:string) {
    const url=new URL(value);
    requireThat(url.protocol==='https:'&&this.allowedOrigins.includes(url.origin)&&!url.username&&!url.password&&!url.hash,'OPEN_PAYMENTS_ORIGIN_NOT_ALLOWED');
    return value;
  }
  async provision(owner:number,asset:Asset,address:string,publicName:string,key:string) {
    const config=this.assets.find(a=>assetKey(a.asset)===assetKey(asset));requireThat(config,'ASSET_NOT_CONFIGURED',503);
    this.assertUrl(address);
    const result=await this.admin.call(`mutation Address($input:CreateWalletAddressInput!){createWalletAddress(input:$input){walletAddress{id address}}}`,
      {input:{assetId:config.assetId,address,publicName,idempotencyKey:key}});
    const created=result.createWalletAddress.walletAddress;requireThat(created?.id,'ADDRESS_PROVISION_FAILED',503);
    await this.store.db.transaction(async tx=>{
      const id=await this.store.account(tx,owner,asset);
      await tx.query(`INSERT INTO payment_wallet_addresses(url,owner_id,account_id,rafiki_id,asset_key) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(url) DO NOTHING`,[address,owner,id,created.id,assetKey(asset)]);
      const [mapping]=await tx.query('SELECT owner_id FROM payment_wallet_addresses WHERE url=$1',[address]);
      requireThat(Number(mapping.owner_id)===owner,'ADDRESS_ALREADY_ASSIGNED',409);
    });return {url:address,asset};
  }
  async incoming(invoice:Invoice) {
    requireThat(invoice.walletAddress,'RECIPIENT_ADDRESS_REQUIRED');
    const [mapping]=await this.store.db.query('SELECT * FROM payment_wallet_addresses WHERE url=$1 AND owner_id=$2',[invoice.walletAddress,invoice.owner]);
    requireThat(mapping,'WALLET_ADDRESS_NOT_OWNED',403);
    const result=await this.admin.call(`mutation Incoming($input:CreateIncomingPaymentInput!){createIncomingPayment(input:$input){payment{id url}}}`,
      {input:{walletAddressId:mapping.rafiki_id,incomingAmount:{value:invoice.amount,assetCode:invoice.asset.code,assetScale:invoice.asset.scale},expiresAt:invoice.expiresAt,idempotencyKey:invoice.id}});
    return this.assertUrl(result.createIncomingPayment.payment.url);
  }
  async remoteInvoice(address:string,asset:Asset,amount:string) {
    requireThat(this.assets.some(a=>assetKey(a.asset)===assetKey(asset)),'ASSET_NOT_CONFIGURED');units(amount);
    const client=await this.client,wallet=await client.walletAddress.get({url:this.assertUrl(address)});
    requireThat(wallet.assetCode===asset.code&&wallet.assetScale===asset.scale,'RECIPIENT_ASSET_MISMATCH',409);
    this.assertUrl(wallet.authServer);this.assertUrl(wallet.resourceServer);
    const grant=await client.grant.request({url:wallet.authServer},{access_token:{access:[{type:'incoming-payment',actions:['create','read'],identifier:wallet.id}]}});
    requireThat(isFinalizedGrantWithAccessToken(grant),'RECIPIENT_GRANT_REQUIRES_INTERACTION',409);
    const expiresAt=new Date(Date.now()+30*60_000).toISOString();
    const incoming=await client.incomingPayment.create({url:wallet.resourceServer,accessToken:grant.access_token.value},
      {walletAddress:wallet.id,incomingAmount:{value:amount,assetCode:asset.code,assetScale:asset.scale},expiresAt});
    return {incomingPayment:this.assertUrl(incoming.id),expiresAt,merchant:wallet.publicName??new URL(wallet.id).hostname};
  }
  async quote(invoice:Invoice) {
    const config=this.assets.find(a=>assetKey(a.asset)===assetKey(invoice.asset));requireThat(config,'ASSET_NOT_CONFIGURED',503);
    requireThat(invoice.incomingPayment,'INCOMING_PAYMENT_REQUIRED');
    const client=await this.client;
    const wallet=await client.walletAddress.get({url:this.assertUrl(config.senderUrl)});
    this.assertUrl(wallet.authServer);this.assertUrl(wallet.resourceServer);this.assertUrl(invoice.incomingPayment);
    const grant=await client.grant.request({url:wallet.authServer},{access_token:{access:[{type:'quote',actions:['create','read']}]}});
    requireThat(isFinalizedGrantWithAccessToken(grant),'QUOTE_GRANT_REQUIRES_INTERACTION',409);
    const quote=await client.quote.create({url:wallet.resourceServer,accessToken:grant.access_token.value},{walletAddress:wallet.id,receiver:invoice.incomingPayment,method:'ilp'});
    requireThat(quote.receiveAmount.value===invoice.amount&&quote.receiveAmount.assetCode===invoice.asset.code&&quote.receiveAmount.assetScale===invoice.asset.scale
      &&quote.debitAmount.assetCode===invoice.asset.code&&quote.debitAmount.assetScale===invoice.asset.scale,'OPEN_PAYMENTS_QUOTE_MISMATCH',409);
    return {debit:quote.debitAmount.value,expiresAt:quote.expiresAt??new Date(Date.now()+30_000).toISOString(),data:{quoteId:new URL(quote.id).pathname.split('/').pop(),quoteUrl:quote.id,senderId:config.senderId,debit:quote.debitAmount.value}};
  }
  async prepare(execution:Execution) {
    requireThat(this.canFund(),'PAYMENTS_PAUSED',503);
    // Admin API supports a durable idempotency key; retrying this operation can
    // (Rafiki keys are not per-mutation, so funding uses a distinct ":fund" key.)
    // therefore recover a lost create response without a second outgoing payment.
    const result=await this.admin.call(`mutation Outgoing($input:CreateOutgoingPaymentInput!){createOutgoingPayment(input:$input){payment{id}}}`,
      {input:{walletAddressId:execution.quote.rail.senderId,quoteId:execution.quote.rail.quoteId,metadata:{ammaExecution:execution.id},idempotencyKey:execution.id}});
    const outgoing=result.createOutgoingPayment.payment;requireThat(outgoing?.id,'OUTGOING_CREATE_FAILED',503);
    await this.store.put(this.store.db,'rafiki-outgoing',execution.id,execution.owner,{id:outgoing.id});
    await this.admin.fund(outgoing.id,`${execution.id}:fund`);
    await this.store.put(this.store.db,'rafiki-outgoing',execution.id,execution.owner,{id:outgoing.id,funded:true});
    return {id:outgoing.id};
  }
  async observe(execution:Execution):Promise<Observation> {
    let rows=await this.store.db.query("SELECT body FROM payment_documents WHERE kind='rafiki-outgoing' AND id=$1 AND owner_id=$2",[execution.id,execution.owner]);
    if(!rows.length){
      // The pinned Rafiki release gives an outgoing payment its quote's ID, so a
      // lookup by quote ID proves whether a create ever succeeded.
      const existing=async()=>{
        try{return (await this.admin.call(`query Existing($id:String!){outgoingPayment(id:$id){id}}`,{id:execution.quote.rail.quoteId})).outgoingPayment as {id:string}|null;}
        catch(error){if(error instanceof PaymentFault&&error.code==='RAFIKI_NOT_FOUND')return null;throw error;}
      };
      const nothingSpent:Observation={state:'failed',reference:execution.id,evidence:{unused:execution.quote.receive}};
      if(this.canFund()&&Date.parse(execution.quote.expiresAt)>Date.now()){
        // Safe retry of idempotent Admin create recovers an uncertain response.
        try{await this.prepare(execution);}
        catch(error){
          if(!(error instanceof PaymentFault&&error.code==='RAFIKI_INPUT_REJECTED')||await existing())throw error;
          return nothingSpent; // Rafiki refused the create (e.g. the recipient closed the incoming payment).
        }
      }else{
        const found=await existing();
        if(!found)return Date.now()>Date.parse(execution.quote.expiresAt)+RAFIKI_QUOTE_LIFESPAN_MS?nothingSpent:{state:'unknown',reference:execution.id};
        await this.store.put(this.store.db,'rafiki-outgoing',execution.id,execution.owner,{id:found.id}); // Lost create response.
      }
      rows=await this.store.db.query("SELECT body FROM payment_documents WHERE kind='rafiki-outgoing' AND id=$1",[execution.id]);
    }
    const outgoing=rows[0].body;
    const result=await this.admin.call(`query Outgoing($id:String!){outgoingPayment(id:$id){id state liquidity sentAmount{value assetCode assetScale} receiveAmount{value assetCode assetScale} debitAmount{value assetCode assetScale} quote{id}}}`,{id:outgoing.id});
    const payment=result.outgoingPayment;requireThat(String(payment?.quote?.id)===execution.quote.rail.quoteId,'OUTGOING_EVIDENCE_MISMATCH',409);
    if(payment.state==='FUNDING'&&this.canFund()){
      await this.admin.fund(outgoing.id,`${execution.id}:fund`);outgoing.funded=true;
      await this.store.put(this.store.db,'rafiki-outgoing',execution.id,execution.owner,outgoing);
    }
    let unused='0';
    if(['COMPLETED','FAILED','CANCELLED'].includes(payment.state)){
      unused=outgoing.unused??String(payment.liquidity??'0');
      requireThat(units(unused,true)<=units(execution.quote.receive),'INVALID_UNUSED_LIQUIDITY',409);
      await this.store.put(this.store.db,'rafiki-outgoing',execution.id,execution.owner,{...outgoing,unused});
      if(units(unused,true)>0n){const result=await this.admin.call(`mutation Withdraw($input:CreateOutgoingPaymentWithdrawalInput!){createOutgoingPaymentWithdrawal(input:$input){success}}`,
        {input:{outgoingPaymentId:outgoing.id,idempotencyKey:`${execution.id}:unused`,timeoutSeconds:'0'}});requireThat(result.createOutgoingPaymentWithdrawal.success,'WITHDRAWAL_UNCONFIRMED',503);}
    }
    if(['FAILED','CANCELLED'].includes(payment.state)) {
      // Partial delivery is an unresolved financial case, never a full refund.
      if(payment.state==='CANCELLED')return {state:'failed',reference:outgoing.id,evidence:{unused:execution.quote.receive}};
      if(!outgoing.funded&&unused==='0')return {state:'unknown',reference:outgoing.id};
      return {state:units(payment.sentAmount.value,true)>0n?'unknown':'failed',reference:outgoing.id,evidence:{unused:(units(unused,true)+units(execution.quote.receive)-units(String(execution.quote.rail.debit??execution.quote.receive))).toString()}};
    }
    if(payment.state!=='COMPLETED')return {state:'pending',reference:outgoing.id};
    const client=await createUnauthenticatedClient({requestTimeoutMs:10_000,logLevel:'silent'}), incoming=await client.incomingPayment.get({url:this.assertUrl(execution.quote.invoice.incomingPayment!)});
    const received=incoming.receivedAmount;
    requireThat(received,'RECIPIENT_AMOUNT_UNAVAILABLE',503);
    requireThat(received.assetCode===execution.quote.invoice.asset.code&&received.assetScale===execution.quote.invoice.asset.scale,'RECIPIENT_ASSET_MISMATCH',409);
    return {state:units(received.value,true)>=units(execution.quote.invoice.amount)?'confirmed':'unknown',reference:outgoing.id,
      received:execution.quote.invoice.amount,assetKey:assetKey(execution.quote.invoice.asset),evidence:{unused:(units(unused,true)+units(execution.quote.receive)-units(String(execution.quote.rail.debit??execution.quote.receive))).toString()}};
  }
}

export class RafikiIdentity {
  constructor(private store:PaymentStore,private base:string,private secret:string,private publicAuth:string,private admin?:RafikiAdmin) {}
  private path(id:string,nonce:string) {requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(id)&&/^[A-Za-z0-9_-]{1,256}$/.test(nonce),'INVALID_INTERACTION');return `/grant/${id}/${nonce}`;}
  async view(owner:number,id:string,nonce:string) {
    const response=await fetch(new URL(this.path(id,nonce),this.base),{redirect:'error',signal:AbortSignal.timeout(5000),headers:{'x-idp-secret':this.secret}});
    requireThat(response.ok,'INTERACTION_UNAVAILABLE',409);
    const grant=await response.json() as any;
    if(this.admin){const detail=await this.admin.call(`query GrantClient($id:ID!){grant(id:$id){id client}}`,{id:grant.grantId});grant.client=detail.grant.client;}
    const access=grant.access_token?.access??grant.access;
    requireThat(Array.isArray(access)&&access.length>0,'UNSUPPORTED_GRANT',403);
    for(const item of access) {
      requireThat(typeof item.identifier==='string','UNSCOPED_GRANT_DENIED',403);
      const mapping=await this.store.db.query('SELECT url FROM payment_wallet_addresses WHERE url=$1 AND owner_id=$2',[item.identifier,owner]);
      requireThat(mapping.length,'GRANT_NOT_OWNED',403);
      requireThat(['outgoing-payment','incoming-payment','quote'].includes(item.type),'UNSUPPORTED_GRANT',403);
      if(item.type==='outgoing-payment'){
        requireThat(item.limits?.debitAmount,'UNBOUNDED_GRANT_DENIED',403);
        requireThat(units(item.limits.debitAmount.value)<=units(maxPaymentUnits()),'PAYMENT_LIMIT_EXCEEDED',403);
      }
    }
    return {grant,hash:digest(grant)};
  }
  async choose(owner:number,id:string,nonce:string,hash:string,approve:boolean) {
    const viewed=await this.view(owner,id,nonce);requireThat(viewed.hash===hash,'GRANT_CHANGED',409);
    const response=await fetch(new URL(`${this.path(id,nonce)}/${approve?'accept':'reject'}`,this.base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'x-idp-secret':this.secret}});
    requireThat(response.ok,'GRANT_UPDATE_FAILED',409);
    if(approve)await this.store.put(this.store.db,'gnap-grant',viewed.grant.grantId,owner,{id:viewed.grant.grantId,access:viewed.grant.access,revoked:false});
    return {finishUrl:new URL(`/interact/${id}/${nonce}/finish`,this.publicAuth).toString()};
  }
  /** Stored grants with their live state from the authorization server. Amma only
   * records the approval; the client may never continue it, or it may be revoked
   * elsewhere. A grant whose state can't be read is shown as unverified, not active. */
  async grants(owner:number){
    const stored=(await this.store.db.query("SELECT body FROM payment_documents WHERE kind='gnap-grant' AND owner_id=$1 ORDER BY created_at DESC LIMIT 100",[owner])).map(row=>row.body as any);
    return Promise.all(stored.map(async grant=>{
      if(grant.revoked||!this.admin)return {...grant,status:grant.revoked?'revoked':'unverified'};
      try{
        const live=(await this.admin.call(`query GrantState($id:ID!){grant(id:$id){id state finalizationReason}}`,{id:grant.id})).grant as {state:string;finalizationReason?:string|null};
        const status=live.state!=='FINALIZED'?'awaiting_client':live.finalizationReason==='ISSUED'?'active':live.finalizationReason==='REJECTED'?'rejected':'revoked';
        return {...grant,status,revoked:['revoked','rejected'].includes(status)};
      }catch{return {...grant,status:'unverified'};}
    }));
  }
  async revoke(owner:number,id:string){
    const grant=await this.store.get<any>(this.store.db,'gnap-grant',id,owner);requireThat(this.admin,'AUTH_ADMIN_UNAVAILABLE',503);
    if(!grant.revoked){await this.admin.call(`mutation Revoke($input:RevokeGrantInput!){revokeGrant(input:$input){id}}`,{input:{grantId:id}});
      grant.revoked=true;await this.store.put(this.store.db,'gnap-grant',id,owner,grant);}
    return grant;
  }
}
