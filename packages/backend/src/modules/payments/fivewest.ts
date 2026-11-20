import Decimal from 'decimal.js';
import { decimal,display,requireThat,units,uuid,PaymentFault } from './domain';

/** Public FiveWest profile/trading contracts, reviewed 2026-10-31. This client
 * does not imply that custody, a chain, a currency or Amma's account is enabled. */
export function exactJson(text:string):any {
  return JSON.parse(text,(_key:string,value:unknown,context?:{source:string})=>{
    if(typeof value!=='number')return value;
    requireThat(context?.source,'EXACT_JSON_PARSING_REQUIRES_NODE_22',503);return context.source;
  });
}
const Exact=Decimal.clone({precision:80});
function providerUnits(value:unknown,scale:number):string {
  requireThat(typeof value==='string','INVALID_PROVIDER_AMOUNT',503);
  const number=new Exact(value),scaled=number.mul(new Exact(10).pow(scale));
  requireThat(number.isFinite()&&scaled.isInteger()&&scaled.gt(0),'INVALID_PROVIDER_AMOUNT',503);return units(scaled.toFixed(0)).toString();
}
export type FiveWestQuote={id:string;fromCurrency:string;toCurrency:string;fromUnits:string;toUnits:string;fromScale:number;toScale:number;
  observedAt:string;acceptBefore:string;status:string};
export class FiveWestClient {
  private token?:{value:string;expires:number};
  constructor(private origin:string,private key:string,private secret:string,private executionVerified=false,
    private transport:typeof fetch=fetch) {
    const url=new URL(origin);requireThat(url.protocol==='https:'&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password,'INVALID_FIVEWEST_ORIGIN');
  }
  private async accessToken(){
    if(this.token&&this.token.expires>Date.now())return this.token.value;
    requireThat(this.key&&this.secret,'FIVEWEST_CREDENTIALS_NOT_CONFIGURED',503);
    const response=await this.transport(new URL('/profile/api/v1/auth/token',this.origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{'Content-Type':'application/json'},body:JSON.stringify({key:this.key,secret:this.secret})});
    requireThat(response.ok,'FIVEWEST_AUTH_UNAVAILABLE',503);const body=exactJson(await response.text());
    requireThat(typeof body.access_token==='string'&&body.access_token.length>0,'INVALID_FIVEWEST_TOKEN',503);
    const ttl=typeof body.expires_in==='string'&&/^\d+$/.test(body.expires_in)?Math.min(Number(body.expires_in),1800):1800;
    this.token={value:body.access_token,expires:Date.now()+Math.max(ttl-30,1)*1000};return this.token.value;
  }
  private async request(path:string,method='GET',body?:string){
    const token=await this.accessToken();
    const response=await this.transport(new URL(path,this.origin),{method,redirect:'error',signal:AbortSignal.timeout(8000),
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body});
    if(response.status===401)this.token=undefined;
    requireThat(response.ok,'FIVEWEST_REQUEST_UNCONFIRMED',503);return exactJson(await response.text());
  }
  async quote(fromCurrency:string,toCurrency:string,toUnits:string,fromScale:number,toScale:number):Promise<FiveWestQuote>{
    requireThat([fromScale,toScale].every(scale=>Number.isInteger(scale)&&scale>=0&&scale<=18),'INVALID_SCALE');
    requireThat(/^[A-Z0-9]{2,12}$/.test(fromCurrency)&&/^[A-Z0-9]{2,12}$/.test(toCurrency)&&fromCurrency!==toCurrency,'INVALID_CURRENCY_PAIR');units(toUnits);
    // Serialize the decimal as a JSON number token without converting via Number.
    const body=`{"from_currency":${JSON.stringify(fromCurrency)},"to_currency":${JSON.stringify(toCurrency)},"to_amount":${display(units(toUnits),toScale)}}`;
    const observed=Date.now(),quote=await this.request('/trading/api/v1/rfq','POST',body);uuid(quote.id);
    const from=quote.base_currency===fromCurrency?quote.base_amount:quote.quote_currency===fromCurrency?quote.quote_amount:undefined;
    const to=quote.base_currency===toCurrency?quote.base_amount:quote.quote_currency===toCurrency?quote.quote_amount:undefined;
    const source=providerUnits(from,fromScale),target=providerUnits(to,toScale);
    requireThat(target===toUnits&&quote.status==='unaccepted','FIVEWEST_QUOTE_MISMATCH',409);
    // Public docs say acceptance is under ten seconds; this local deadline is
    // conservative, and is not a promise that the provider locks the price.
    return {id:quote.id,fromCurrency,toCurrency,fromUnits:source,toUnits:target,fromScale,toScale,status:quote.status,
      observedAt:new Date(observed).toISOString(),acceptBefore:new Date(observed+5000).toISOString()};
  }
  async getQuote(id:string){return this.request(`/trading/api/v1/rfq/${encodeURIComponent(uuid(id))}`);}
  async balance(symbol:string){requireThat(/^[A-Z0-9]{2,12}$/.test(symbol),'INVALID_CURRENCY');return this.request(`/wallet/api/v1/balance/${encodeURIComponent(symbol)}`);}
  async accept(quote:FiveWestQuote,maxSourceUnits:string){
    requireThat(this.executionVerified,'FIVEWEST_EXECUTION_NOT_VERIFIED',503);
    requireThat(units(quote.fromUnits)<=units(maxSourceUnits),'FIVEWEST_QUOTE_EXCEEDS_APPROVAL',409);
    requireThat(Date.parse(quote.acceptBefore)>Date.now(),'FIVEWEST_QUOTE_EXPIRED',409);
    const current=await this.getQuote(quote.id);
    const source=current.base_currency===quote.fromCurrency?current.base_amount:current.quote_currency===quote.fromCurrency?current.quote_amount:undefined;
    const target=current.base_currency===quote.toCurrency?current.base_amount:current.quote_currency===quote.toCurrency?current.quote_amount:undefined;
    requireThat(providerUnits(source,quote.fromScale)===quote.fromUnits&&providerUnits(target,quote.toScale)===quote.toUnits,'FIVEWEST_QUOTE_MISMATCH',409);
    if(current.status==='accepted')return current; // Reconcile the existing trade, never create a replacement.
    requireThat(current.status==='unaccepted'&&Date.parse(quote.acceptBefore)>Date.now(),'FIVEWEST_QUOTE_EXPIRED',409);
    // Persist the RFQ ID before invoking this method. There is deliberately no
    // automatic POST retry: after an ambiguous result, inspect this same RFQ ID.
    try{return await this.request(`/trading/api/v1/rfq/accept_quote/${encodeURIComponent(uuid(quote.id))}`,'POST');}
    catch{throw new PaymentFault('FIVEWEST_ACCEPTANCE_UNRESOLVED',409);}
  }
  async trade(id:string){return this.request(`/trading/api/v1/trades/${encodeURIComponent(uuid(id))}`);}
}
