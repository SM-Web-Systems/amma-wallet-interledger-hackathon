import postgres from 'postgres';
import { Horizon, Networks } from '@stellar/stellar-sdk';
import { resolveDatabaseUrl } from '../../lib/docker-secrets';
import { PaymentStore, type Database, type Session } from './store';
import { PaymentService } from './service';
import { ManagedAdapter, PartnerGateway } from './adapters';
import { StellarFundingAdapter } from './stellar-adapter';
import { XrplFundingAdapter } from './xrpl-adapter';
import { RafikiAdmin, RafikiIdentity, RafikiRail, type RafikiAsset } from './rafiki';
import { assetKey, requireThat, type Asset } from './domain';
import { ProviderEvents } from './provider-events';
import { paymentsEnabled,paymentsCanSubmit,rafikiUrlAllowed,xrplFundingRailAllowed } from './configuration';

export {paymentsEnabled,paymentsCanSubmit} from './configuration';
export function postgresDatabase(connection: ReturnType<typeof postgres>):Database {
  const session=(sql:any):Session=>({query:async(text,params=[])=>Array.from(await sql.unsafe(text,params)) as any});
  return {...session(connection),transaction:async fn=>connection.begin(async tx=>fn(session(tx))) as any};
}
export async function createPaymentRuntime() {
  if(!paymentsEnabled())return null;
  for(const name of ['RAFIKI_IDP_SECRET','RAFIKI_WEBHOOK_SECRET'])requireThat((process.env[name]??'').length>=32,'PAYMENT_SECRET_TOO_SHORT');
  for(const name of ['RAFIKI_INTERACTION_URL','RAFIKI_AUTH_URL'])requireThat(rafikiUrlAllowed(name,process.env[name]),'INVALID_RAFIKI_URL');
  const assets=JSON.parse(process.env.PAYMENTS_RAFIKI_ASSETS??'[]') as RafikiAsset[];
  requireThat(assets.length>0,'PAYMENT_ASSETS_REQUIRED');assets.forEach(a=>assetKey(a.asset));
  const admin=new RafikiAdmin(process.env.RAFIKI_ADMIN_URL??'',process.env.RAFIKI_TENANT_ID??'',process.env.RAFIKI_ADMIN_SECRET??'');
  const connection=postgres(resolveDatabaseUrl(),{max:6,connect_timeout:5,idle_timeout:20});
  const store=new PaymentStore(postgresDatabase(connection));
  const rail=new RafikiRail(store,admin,assets,process.env.OPEN_PAYMENTS_CLIENT_ADDRESS??'',process.env.OPEN_PAYMENTS_KEY_ID??'',process.env.OPEN_PAYMENTS_PRIVATE_KEY_FILE??'',
    (process.env.OPEN_PAYMENTS_ALLOWED_ORIGINS??'').split(',').filter(Boolean),paymentsCanSubmit);
  try{await rail.ready();}catch(error){await connection.end({timeout:1});throw error;}
  const partner=process.env.PAYMENTS_PARTNER_GATEWAY?new PartnerGateway(process.env.PAYMENTS_PARTNER_GATEWAY,process.env.PAYMENTS_PARTNER_TOKEN??'',
    process.env.PAYMENTS_PARTNER==='tdme'?'tdme':'fivewest',process.env.PAYMENTS_PARTNER_VERIFIED==='true'):undefined;
  const network=process.env.STELLAR_NETWORK==='public'?'public':'testnet';
  const adapters=[new ManagedAdapter(store,partner)] as import('./domain').FundingAdapter[];
  if(process.env.PAYMENTS_STELLAR_TREASURY)adapters.push(new StellarFundingAdapter(store,new Horizon.Server(process.env.HORIZON_URL??'https://horizon-testnet.stellar.org'),
    network==='public'?Networks.PUBLIC:Networks.TESTNET,network,process.env.PAYMENTS_STELLAR_TREASURY,assets.map(a=>a.asset).filter(a=>a.chain==='stellar')));
  if(xrplFundingRailAllowed(!!partner))adapters.push(new XrplFundingAdapter(store,partner!));
  const service=new PaymentService(store,adapters,rail,paymentsCanSubmit);
  const events=new ProviderEvents(store,admin,paymentsCanSubmit);
  const authAdmin=process.env.RAFIKI_AUTH_ADMIN_URL?new RafikiAdmin(process.env.RAFIKI_AUTH_ADMIN_URL,process.env.RAFIKI_TENANT_ID??'',process.env.RAFIKI_ADMIN_SECRET??''):undefined;
  const identity=new RafikiIdentity(store,process.env.RAFIKI_INTERACTION_URL??'',process.env.RAFIKI_IDP_SECRET??'',process.env.RAFIKI_AUTH_URL??'',authAdmin);
  let ticking=false,lastCatchUp=0;
  const catchUpEvery=Number(process.env.PAYMENTS_CATCHUP_INTERVAL_MS??300_000);
  const timer=setInterval(()=>{
    if(ticking)return;ticking=true;
    // Webhooks can be lost; a slower scan of Rafiki's own records queues anything they missed.
    // A failed scan waits for the next interval rather than retrying every tick.
    const due=Date.now()-lastCatchUp>=catchUpEvery;if(due)lastCatchUp=Date.now();
    const catchUp=due?events.catchUp().catch(()=>{console.warn(JSON.stringify({event:'payment_catch_up_unavailable'}));}):Promise.resolve();
    catchUp.then(()=>service.tick()).then(()=>events.tick()).catch(()=>{console.warn(JSON.stringify({event:'payment_worker_unavailable'}));}).finally(()=>{ticking=false;});
  },5000);timer.unref();
  return {service,rail,identity,assets,async close(){clearInterval(timer);await connection.end({timeout:15});}};
}
