import { readXrplConfig } from '../xrpl/config';

export const paymentsEnabled=()=>process.env.PAYMENTS_ENABLED==='true';
/** The XRP funding rail reads testnet wallets only, so it is registered only when the XRP pipeline is on testnet (never with XRPL_MAINNET_CUSTODY=on). */
export const xrplFundingRailAllowed=(hasPartner:boolean,env:NodeJS.ProcessEnv=process.env)=>
  hasPartner&&env.XRPL_ENABLED==='true'&&readXrplConfig(env).network==='testnet';
export const paymentsCanSubmit=()=>paymentsEnabled()&&process.env.PAYMENTS_PAUSED==='false'
  &&(process.env.NODE_ENV!=='production'||process.env.PAYMENTS_LIVE_VERIFIED==='true');
export const maxPaymentUnits=()=>process.env.PAYMENTS_MAX_RECEIVE_UNITS??'10000000000';
export const maxDailyUnits=()=>process.env.PAYMENTS_DAILY_MAX_UNITS??'100000000000';

// Rafiki URLs Amma calls must be https, except for named in-network services.
// RAFIKI_INTERACTION_URL is called server-side with the IdP secret in a header, so
// it should stay on the private Docker network (e.g. http://auth-a:3009) rather than
// go out through a public hostname. Plain http is allowed only outside production,
// or for a single-label host (a Docker service name, never a public domain or IP)
// that the operator lists in PAYMENTS_INTERNAL_HOSTS. The same rule covers the Admin GraphQL
// URLs (RAFIKI_ADMIN_URL, RAFIKI_AUTH_ADMIN_URL), which must never be published.
const SERVICE_NAME=/^[a-z0-9][a-z0-9_-]{0,62}$/;
export const internalHosts=(env:NodeJS.ProcessEnv=process.env)=>
  (env.PAYMENTS_INTERNAL_HOSTS??'').split(',').map(h=>h.trim().toLowerCase()).filter(h=>SERVICE_NAME.test(h));
// Private Rafiki endpoints (interaction, Admin GraphQL) may be plain http on the Docker network.
export function internalRafikiUrlAllowed(value:string|undefined,env:NodeJS.ProcessEnv=process.env):boolean {
  let url:URL;
  try{url=new URL(value??'');}catch{return false;}
  if(url.username||url.password)return false;
  if(url.protocol==='https:')return true;
  if(url.protocol!=='http:')return false;
  if(env.NODE_ENV!=='production')return true;
  return internalHosts(env).includes(url.hostname.toLowerCase());
}
export function rafikiUrlAllowed(name:string,value:string|undefined,env:NodeJS.ProcessEnv=process.env):boolean {
  if(name==='RAFIKI_INTERACTION_URL')return internalRafikiUrlAllowed(value,env);
  let url:URL;
  try{url=new URL(value??'');}catch{return false;}
  return url.protocol==='https:'&&!url.username&&!url.password;
}
