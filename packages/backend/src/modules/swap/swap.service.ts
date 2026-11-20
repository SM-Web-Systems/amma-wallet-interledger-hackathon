import * as StellarSdk from '@stellar/stellar-sdk';
import Decimal from 'decimal.js';
import { stellarClient } from '../../lib/stellar-client';
const Money=Decimal.clone({precision:80,rounding:Decimal.ROUND_DOWN});
interface SwapQuote {
  source:string;sourceAsset:{code:string;issuer?:string};destAsset:{code:string;issuer?:string};
  sourceAmount:string;destAmount:string;path:Array<{code:string;issuer?:string}>;priceImpact:string;fee:string;
  direction?:'send'|'receive';
}
export class SwapService {
  async getBestQuote(fromCode:string,fromIssuer:string|null,toCode:string,toIssuer:string|null,amount:string,direction:'send'|'receive'='send'):Promise<SwapQuote[]> {
    if(!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(amount)||!new Money(amount).gt(0))throw new Error('amount must be a positive number');
    const source=fromIssuer?new StellarSdk.Asset(fromCode,fromIssuer):StellarSdk.Asset.native();
    const destination=toIssuer?new StellarSdk.Asset(toCode,toIssuer):StellarSdk.Asset.native();
    // Horizon paths include order books and pools; indicative prices must never
    // masquerade as executable fixed-receive quotes.
    const quotes=await this.getHorizonPaths(source,destination,amount,direction);
    return quotes.sort((a,b)=>direction==='receive'?new Money(a.sourceAmount).cmp(b.sourceAmount):new Money(b.destAmount).cmp(a.destAmount));
  }
  private async getHorizonPaths(source:StellarSdk.Asset,destination:StellarSdk.Asset,amount:string,direction:'send'|'receive'):Promise<SwapQuote[]> {
    try {
      const request=direction==='receive'?stellarClient.horizon.strictReceivePaths([source],destination,amount):stellarClient.horizon.strictSendPaths(source,amount,[destination]);
      const paths=await request.limit(5).call();
      return paths.records.map((path:any)=>({source:'PATH',sourceAsset:{code:source.code,issuer:source.issuer},destAsset:{code:destination.code,issuer:destination.issuer},
        sourceAmount:path.source_amount,destAmount:path.destination_amount,direction,path:path.path.map((asset:any)=>({code:asset.asset_type==='native'?'XLM':asset.asset_code,issuer:asset.asset_issuer})),priceImpact:'0',fee:'0.0000100'}));
    }catch{return [];}
  }
  async buildSwapTransaction(signerPublicKey:string,quote:SwapQuote,slippageBps=100):Promise<string> {
    if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>1000)throw new Error('Invalid slippage');
    const source=quote.sourceAsset.issuer?new StellarSdk.Asset(quote.sourceAsset.code,quote.sourceAsset.issuer):StellarSdk.Asset.native();
    const destination=quote.destAsset.issuer?new StellarSdk.Asset(quote.destAsset.code,quote.destAsset.issuer):StellarSdk.Asset.native();
    const path=quote.path.map(a=>a.issuer?new StellarSdk.Asset(a.code,a.issuer):StellarSdk.Asset.native());
    const account=await stellarClient.horizon.loadAccount(signerPublicKey);
    const operation=quote.direction==='receive'?StellarSdk.Operation.pathPaymentStrictReceive({sendAsset:source,
      sendMax:new Money(quote.sourceAmount).mul(10_000+slippageBps).div(10_000).toFixed(7,Decimal.ROUND_UP),destination:signerPublicKey,
      destAsset:destination,destAmount:quote.destAmount,path}):StellarSdk.Operation.pathPaymentStrictSend({sendAsset:source,sendAmount:quote.sourceAmount,
      destination:signerPublicKey,destAsset:destination,destMin:new Money(quote.destAmount).mul(10_000-slippageBps).div(10_000).toFixed(7,Decimal.ROUND_DOWN),path});
    return new StellarSdk.TransactionBuilder(account,{fee:StellarSdk.BASE_FEE,networkPassphrase:stellarClient.networkPassphrase}).addOperation(operation).setTimeout(180).build().toXDR();
  }
  private calcPriceImpact(asks:any[],amount:string):string {
    if(!asks.length)return '0';
    try {
      const quantity=new Money(amount),spot=new Money(asks[0].price);
      if(!quantity.gt(0)||!spot.gt(0))return '0';
      let remaining=quantity,total=new Money(0);
      for(const ask of asks){const fill=Money.min(remaining,ask.amount);total=total.add(fill.mul(ask.price));remaining=remaining.sub(fill);if(remaining.lte(0))break;}
      return total.div(quantity).sub(spot).div(spot).mul(100).toFixed(2);
    }catch{return '0';}
  }
}
