import { requireThat, units, type Asset, type Execution, type FundingAdapter, type Leg, type Observation, type Source } from './domain';
import { PaymentStore } from './store';
import { PartnerGateway } from './adapters';
import { XrplPaymentService } from '../xrpl/payment-service';
import { XrplReconciliationAdapter } from '../xrpl/reconciliation-adapter';

export class XrplFundingAdapter implements FundingAdapter {
  id='xrpl';
  constructor(private store: PaymentStore,private partner: PartnerGateway,private payments=new XrplPaymentService(),private network=new XrplReconciliationAdapter()) {}
  async sources(owner: number):Promise<Source[]> {
    const wallets=await this.store.db.query("SELECT id::text,public_key FROM user_wallets WHERE user_id=$1 AND chain='xrpl' AND network='testnet'",[owner]);
    return Promise.all(wallets.map(async wallet=>{
      const observed=await this.network.getAccount(wallet.public_key), fee=await this.network.getFee();
      const available=units(observed.spendableDrops,true)-1000n;
      return {id:`xrpl:testnet:${wallet.id}`,walletId:wallet.id,address:wallet.public_key,adapter:this.id,asset:{chain:'xrpl' as const,network:'testnet',code:'XRP',scale:6},
        available:(available>0n?available:0n).toString()};
    }));
  }
  async routes(source: Source,target: Asset) {return (await this.partner.routes(source,target)).map(route=>({...route,networkFee:{asset:source.asset,amount:'1000',valuationNumerator:route.valuationNumerator,valuationDenominator:route.valuationDenominator,available:(units(source.available,true)+1000n).toString()}}));}
  async prepare(owner: number,execution: Execution,leg: Leg) {
    const reserved=await this.partner.prepare(execution,leg);
    requireThat(typeof reserved.depositAddress==='string','PARTNER_DEPOSIT_MISSING',503);
    const intent=await this.payments.create(owner,{schemaVersion:1,walletId:leg.route.source.walletId,chain:'xrpl',network:'testnet',
      destination:reserved.depositAddress,...(reserved.destinationTag===undefined?{}:{destinationTag:reserved.destinationTag}),
      amountDrops:leg.maxDebit,maxFeeDrops:'1000',reference:leg.id},leg.id);
    const prepared=await this.payments.prepare(owner,intent.id);
    return {chain:'xrpl',network:'testnet',intent:prepared,conversion:reserved};
  }
  async submit(owner: number,leg: Leg,signature: unknown) {
    const intent=leg.prepared?.intent as any;requireThat(intent?.preparationId,'FUNDING_NOT_READY',409);
    await this.payments.submit(owner,intent.id,intent.preparationId,signature);
  }
  async observe(owner: number,leg: Leg):Promise<Observation> {
    const intent=leg.prepared?.intent as any;requireThat(intent,'FUNDING_NOT_READY',409);
    const status=await this.payments.status(owner,intent.id);
    if(['expired','cancelled','validated_failure'].includes(status.state))return {state:'failed',reference:intent.id};
    if(status.state!=='validated_success')return {state:'pending',reference:intent.id,evidence:{requiresSignature:status.state==='prepared'}};
    const receipt=await this.payments.receipt(owner,intent.id);
    requireThat(receipt.deliveredAmountDrops===leg.maxDebit&&receipt.destination===intent.destination&&receipt.destinationTag===intent.destinationTag,'FUNDING_EVIDENCE_MISMATCH',409);
    return this.partner.observe(leg,receipt);
  }
}
