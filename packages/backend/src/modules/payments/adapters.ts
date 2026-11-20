import { assetKey, ceil, requireThat, units, type Asset, type Execution, type FundingAdapter, type Leg, type Observation, type Route, type Source } from './domain';
import { PaymentStore } from './store';

/** This is Amma's integration-gateway contract, NOT a claimed TDME/FiveWest API.
 * Enable only after the partner-specific mapping passes contract tests. */
export class PartnerGateway {
  constructor(private base: string, private token: string, public provider: 'tdme'|'fivewest', private verified: boolean) {}
  async request<T>(path: string, body: unknown): Promise<T> {
    requireThat(this.verified && this.token.length>=16 && new URL(this.base).protocol==='https:','PARTNER_NOT_VERIFIED',503);
    const response=await fetch(new URL(path,this.base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.token}`},body:JSON.stringify(body)});
    requireThat(response.ok,'PARTNER_UNAVAILABLE',503);return response.json() as Promise<T>;
  }
  async routes(source: Source,target: Asset): Promise<Route[]> {
    const result=await this.request<{routes: Omit<Route,'source'>[]}>('/v1/routes',{source,target});
    requireThat(Array.isArray(result.routes)&&result.routes.length<=8,'INVALID_PARTNER_QUOTE',503);
    return result.routes.map(route=>({...route,source,evidence:{...route.evidence,provider:this.provider},simulated:false}));
  }
  async prepare(execution: Execution,leg: Leg) {
    const result=await this.request<Record<string,unknown>>('/v1/conversions/prepare',{
      clientReference:leg.id,route:leg.route.evidence,source:leg.route.source.asset,target:execution.quote.invoice.asset,
      receive:leg.receive,maxDebit:leg.maxDebit});
    requireThat(result.maxDebit===leg.maxDebit&&result.receive===leg.receive&&result.targetAssetKey===assetKey(execution.quote.invoice.asset),'PARTNER_QUOTE_CHANGED',409);
    return result;
  }
  observe(leg: Leg,proof?: unknown) {return this.request<Observation>('/v1/conversions/observe',{clientReference:leg.id,proof});}
}

export class ManagedAdapter implements FundingAdapter {
  id='managed';
  constructor(private store: PaymentStore,private partner?: PartnerGateway) {}
  async sources(owner: number): Promise<Source[]> {
    return (await this.store.balances(owner)).map(row=>({id:`managed:${row.id}`,accountId:row.id,asset:row.asset,available:row.available,adapter:this.id}));
  }
  async routes(source: Source,target: Asset): Promise<Route[]> {
    if(assetKey(source.asset)!==assetKey(target))return this.partner?this.partner.routes(source,target):[];
    return [{id:source.id,source,capacity:source.available,numerator:'1',denominator:'1',fee:'0',valuationNumerator:'1',valuationDenominator:'1',
      expiresAt:new Date(Date.now()+60_000).toISOString(),evidence:{targetAssetKey:assetKey(target)}}];
  }
  async prepare(_owner: number,execution: Execution,leg: Leg) {
    if(assetKey(leg.route.source.asset)!==assetKey(execution.quote.invoice.asset)) {
      requireThat(this.partner,'CONVERSION_UNAVAILABLE',503);return this.partner.prepare(execution,leg);
    }
    return {targetAssetKey:assetKey(execution.quote.invoice.asset),receive:leg.receive,direct:true};
  }
  async submit() {throw new Error('Managed funds do not accept client signatures');}
  async observe(_owner: number,leg: Leg): Promise<Observation> {
    if(leg.prepared?.direct)return {state:'confirmed',reference:leg.id,received:leg.receive,assetKey:String(leg.prepared.targetAssetKey)};
    requireThat(this.partner,'CONVERSION_UNAVAILABLE',503);return this.partner.observe(leg);
  }
}

// Test-only adapter is deliberately not wired into the production server.
export class FixtureAdapter implements FundingAdapter {
  id='fixture';
  constructor(private fixtures: Source[],private fixtureRoutes: Route[]) {}
  async sources() {return this.fixtures;}
  async routes(source: Source) {return this.fixtureRoutes.filter(r=>r.source.id===source.id).map(r=>({...r,simulated:true}));}
  async prepare(_owner: number,execution: Execution,leg: Leg) {return {targetAssetKey:assetKey(execution.quote.invoice.asset),receive:leg.receive};}
  async submit() {}
  async observe(_owner: number,leg: Leg):Promise<Observation>{return {state:'confirmed',reference:leg.id,received:leg.receive,assetKey:String(leg.prepared?.targetAssetKey)};}
}
