import * as Stellar from '@stellar/stellar-sdk';
import { assetKey, decimal, display, digest, requireThat, units, type Asset, type Execution, type FundingAdapter, type Leg, type Observation, type Route, type Source } from './domain';
import { PaymentStore } from './store';

export class StellarFundingAdapter implements FundingAdapter {
  id='stellar';
  constructor(private store: PaymentStore,private server: Stellar.Horizon.Server,private passphrase: string,
    private network: 'public'|'testnet',private treasury: string,private assets: Asset[]) {}
  private stellar(asset: Asset) {return asset.code==='XLM'&&!asset.issuer?Stellar.Asset.native():new Stellar.Asset(asset.code,asset.issuer!);}
  async sources(owner: number):Promise<Source[]> {
    const wallets=await this.store.db.query("SELECT id::text,public_key FROM user_wallets WHERE user_id=$1 AND chain='stellar' AND network=$2",[owner,this.network]);
    const sources:Source[]=[];
    for(const wallet of wallets) {
      let account;
      // An unfunded account has nothing to spend. Any other Horizon failure still
      // fails the whole lookup, so an unread balance is never shown as spendable.
      try{account=await this.server.loadAccount(wallet.public_key);}catch(error){if(isNotFound(error))continue;throw error;}
      const ledger=await this.server.ledgers().order('desc').limit(1).call();
      const reserve=BigInt(ledger.records[0].base_reserve_in_stroops)*(2n+BigInt(account.subentry_count)+BigInt((account as any).num_sponsoring??0)-BigInt((account as any).num_sponsored??0));
      for(const balance of account.balances) {
        if(balance.asset_type==='liquidity_pool_shares')continue;
        const b=balance as any, code=b.asset_type==='native'?'XLM':b.asset_code;
        const asset=this.assets.find(a=>a.code===code&&(a.issuer??'')===(b.asset_issuer??'')&&a.network===this.network);
        if(!asset)continue;
        let available=decimal(b.balance,7)-decimal(b.selling_liabilities??'0',7);
        if(code==='XLM')available-=reserve+1000n; // Bound/sponsor transaction fee separately from reserves.
        sources.push({id:`stellar:${wallet.id}:${assetKey(asset)}`,walletId:wallet.id,address:wallet.public_key,asset,adapter:this.id,
          available:(available>0n?available:0n).toString(),reason:b.is_authorized===false?'ASSET_NOT_AUTHORIZED':undefined});
      }
    }return sources;
  }
  async routes(source: Source,target: Asset,amount?:string):Promise<Route[]> {
    if(target.chain!=='stellar'||target.network!==this.network||!this.assets.some(a=>assetKey(a)===assetKey(target)))return [];
    const [wallet]=await this.store.db.query('SELECT public_key FROM user_wallets WHERE id=$1',[source.walletId]);
    const account=await this.server.loadAccount(wallet.public_key),native=account.balances.find((b:any)=>b.asset_type==='native') as any;
    const ledger=await this.server.ledgers().order('desc').limit(1).call();
    const reserve=BigInt(ledger.records[0].base_reserve_in_stroops)*(2n+BigInt(account.subentry_count)+BigInt((account as any).num_sponsoring??0)-BigInt((account as any).num_sponsored??0));
    const feeAvailable=decimal(native.balance,7)-decimal(native.selling_liabilities??'0',7)-reserve;
    if(feeAvailable<1000n)return [];
    let feeValue=10_000_000n;
    if(target.code!=='XLM'||target.issuer){const fees=await this.server.strictSendPaths(Stellar.Asset.native(),'1.0000000',[this.stellar(target)]).limit(5).call();
      feeValue=fees.records.reduce((v,p)=>decimal(p.destination_amount,7)>v?decimal(p.destination_amount,7):v,0n);if(!feeValue)return [];}
    const networkFee={asset:{chain:'stellar' as const,network:this.network,code:'XLM',scale:7},amount:'1000',valuationNumerator:feeValue.toString(),valuationDenominator:'10000000',available:feeAvailable.toString()};
    // Exact route prices are obtained at requested amounts by the quote adapter.
    // Native same-asset funding has an executable 1:1 conversion.
    if(assetKey(source.asset)!==assetKey(target)) {
      if(!amount||units(source.available,true)===0n)return [];
      const sent=await this.server.strictSendPaths(this.stellar(source.asset),display(units(source.available),7),[this.stellar(target)]).limit(5).call();
      const max=sent.records.reduce((value,p)=>decimal(p.destination_amount,7)>value?decimal(p.destination_amount,7):value,0n);
      const capacity=max<units(amount)?max:units(amount);if(!capacity)return [];
      const paths=await this.server.strictReceivePaths([this.stellar(source.asset)],this.stellar(target),display(capacity,7)).limit(5).call();
      return paths.records.map((p,index)=>{
        const debit=decimal(p.source_amount,7);
        return {id:`${source.id}:${index}`,source,capacity:capacity.toString(),numerator:debit.toString(),denominator:capacity.toString(),
          fee:'0',valuationNumerator:max.toString(),valuationDenominator:source.available,networkFee,expiresAt:new Date(Date.now()+30_000).toISOString(),
          evidence:{target,treasury:this.treasury,path:p.path.map((a:any)=>({chain:'stellar',network:this.network,code:a.asset_type==='native'?'XLM':a.asset_code,issuer:a.asset_issuer,scale:7}))}};
      });
    }
    return [{id:source.id,source,capacity:source.available,numerator:'1',denominator:'1',fee:'0',valuationNumerator:'1',valuationDenominator:'1',networkFee,
      expiresAt:new Date(Date.now()+60_000).toISOString(),evidence:{target,treasury:this.treasury}}];
  }
  async prepare(owner: number,execution: Execution,leg: Leg) {
    const existing=await this.store.db.query("SELECT body FROM payment_documents WHERE kind='stellar-funding' AND id=$1 AND owner_id=$2",[leg.id,owner]);
    if(existing.length)return existing[0].body.prepared;
    const [wallet]=await this.store.db.query("SELECT public_key FROM user_wallets WHERE id=$1 AND user_id=$2 AND chain='stellar' AND network=$3",[leg.route.source.walletId,owner,this.network]);
    requireThat(wallet,'WALLET_NOT_FOUND',404);requireThat(Stellar.StrKey.isValidEd25519PublicKey(this.treasury),'TREASURY_NOT_CONFIGURED',503);
    const account=await this.server.loadAccount(wallet.public_key),target=execution.quote.invoice.asset;
    let path=(leg.route.evidence.path as Asset[]??[]);
    if(assetKey(leg.route.source.asset)!==assetKey(target)) {
      const refreshed=await this.server.strictReceivePaths([this.stellar(leg.route.source.asset)],this.stellar(target),display(units(leg.receive),7)).limit(5).call();
      const eligible=refreshed.records.filter(p=>decimal(p.source_amount,7)<=units(leg.maxDebit));
      requireThat(eligible.length,'FUNDING_QUOTE_CHANGED',409);
      eligible.sort((a,b)=>decimal(a.source_amount,7)<decimal(b.source_amount,7)?-1:1);
      path=eligible[0].path.map((a:any)=>({chain:'stellar',network:this.network,code:a.asset_type==='native'?'XLM':a.asset_code,issuer:a.asset_issuer,scale:7}));
    }
    const tx=new Stellar.TransactionBuilder(account,{fee:'1000',networkPassphrase:this.passphrase})
      .addOperation(Stellar.Operation.pathPaymentStrictReceive({sendAsset:this.stellar(leg.route.source.asset),sendMax:display(units(leg.maxDebit),7),
        destination:this.treasury,destAsset:this.stellar(target),destAmount:display(units(leg.receive),7),path:path.map(a=>this.stellar(a))}))
      .addMemo(Stellar.Memo.hash(digest({execution:execution.id,leg:leg.id}))).setTimeout(180).build();
    const prepared={chain:'stellar',network:this.network,xdr:tx.toXDR(),hash:tx.hash().toString('hex'),source:wallet.public_key,
      targetAssetKey:assetKey(target),receive:leg.receive,maxDebit:leg.maxDebit,networkFee:'1000',treasury:this.treasury};
    await this.store.put(this.store.db,'stellar-funding',leg.id,owner,{prepared});return prepared;
  }
  async submit(owner: number,leg: Leg,signature: unknown) {
    requireThat(typeof signature==='string'&&signature.length<32_768,'INVALID_SIGNATURE');
    const record=await this.store.get<any>(this.store.db,'stellar-funding',leg.id,owner);
    const tx=Stellar.TransactionBuilder.fromXDR(signature,this.passphrase);
    requireThat(tx instanceof Stellar.Transaction && tx.hash().toString('hex')===record.prepared.hash,'SIGNED_TRANSACTION_MISMATCH');
    const key=Stellar.Keypair.fromPublicKey(record.prepared.source);
    requireThat(tx.signatures.some(s=>key.verify(tx.hash(),s.signature())),'INVALID_SIGNATURE');
    await this.store.db.transaction(async session=>{
      const saved=await this.store.get<any>(session,'stellar-funding',leg.id,owner,true);
      requireThat(!saved.signed||saved.signed===signature,'SIGNED_TRANSACTION_CONFLICT',409);
      await this.store.put(session,'stellar-funding',leg.id,owner,{...saved,signed:signature});
    });
    // Signed evidence is durable before sending; errors are reconciled by hash.
    try{await this.server.submitTransaction(tx);}catch{ /* uncertain until observed */ }
  }
  async observe(owner: number,leg: Leg):Promise<Observation> {
    const record=await this.store.get<any>(this.store.db,'stellar-funding',leg.id,owner);
    if(!record.signed){
      const prepared=Stellar.TransactionBuilder.fromXDR(record.prepared.xdr,this.passphrase);
      if(prepared instanceof Stellar.Transaction&&Number(prepared.timeBounds?.maxTime)*1000<Date.now())return {state:'failed',reference:leg.id};
      return {state:'pending',reference:leg.id,evidence:{requiresSignature:true}};
    }
    try {
      const tx=await this.server.transactions().transaction(record.prepared.hash).call();
      if(!tx.successful)return {state:'failed',reference:tx.hash};
      // The SDK's `ledger` is a link function; the ledger number is `ledger_attr`.
      return {state:'confirmed',reference:tx.hash,received:leg.receive,assetKey:String(record.prepared.targetAssetKey),evidence:{ledger:tx.ledger_attr}};
    }catch(error){
      // Only an authoritative 404 plus a closed ledger after maxTime proves that
      // this exact transaction can never apply. Any other error stays unknown.
      if(!isNotFound(error))return {state:'unknown',reference:record.prepared.hash};
      const prepared=Stellar.TransactionBuilder.fromXDR(record.prepared.xdr,this.passphrase);
      const maxTime=prepared instanceof Stellar.Transaction?Number(prepared.timeBounds?.maxTime??0)*1000:0;
      if(!maxTime)return {state:'unknown',reference:record.prepared.hash};
      try{
        const closedAt=Date.parse((await this.server.ledgers().order('desc').limit(1).call()).records[0]?.closed_at);
        if(Number.isFinite(closedAt)&&closedAt>maxTime)
          return {state:'failed',reference:record.prepared.hash,evidence:{code:'TIME_BOUNDS_EXPIRED_NOT_INCLUDED',maxTime:new Date(maxTime).toISOString(),ledgerClosedAt:new Date(closedAt).toISOString()}};
      }catch{/* ledger head unavailable: still uncertain */}
      return {state:'unknown',reference:record.prepared.hash};
    }
  }
}
const isNotFound=(error:unknown)=>{const e=error as {name?:string;response?:{status?:number}};return e?.response?.status===404||e?.name==='NotFoundError';};
