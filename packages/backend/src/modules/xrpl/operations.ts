import { sql } from "drizzle-orm";
import { db } from "../../db";
import { XrplReadAdapter } from "./read-adapter";
import { readXrplConfig, type MonitorConfig, type XrplNetwork } from "./config";
import { submissionAvailability, type SubmissionAvailability } from "./submission-control";
import { MAX_BROADCASTS } from "./reconciler";

export interface PendingSummary { prepared:number;signed:number;submitted:number;overdue:number;quarantined:number;retryBudgetExhausted:number;activeLeases:number;oldestAgeSeconds:number }
export interface EndpointSummary { id:number;status:"healthy"|"unavailable";validatedLedgerIndex?:number }
export interface OperationsSnapshot {schemaVersion:1;chain:"xrpl";network:XrplNetwork;status:"disabled"|"starting"|"healthy"|"degraded"|"unavailable";checkedAt:string|null;submission:SubmissionAvailability;pending:PendingSummary|null;endpoints:EndpointSummary[]}
export const initialSnapshot=(enabled:boolean,network:XrplNetwork="testnet"):OperationsSnapshot=>({schemaVersion:1,chain:"xrpl",network,status:enabled?"starting":"disabled",checkedAt:null,submission:submissionAvailability(),pending:null,endpoints:[]});

export async function pendingSummary(threshold:number,network:XrplNetwork="testnet"):Promise<PendingSummary> {
  // One aggregate query. Never emit owner IDs, addresses, hashes, blobs or refs.
  const rows=await db.transaction(async tx=>{
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    return tx.execute(sql`SELECT
    count(*) FILTER(WHERE state='prepared') AS prepared,
    count(*) FILTER(WHERE state='signed') AS signed,
    count(*) FILTER(WHERE state='submitted') AS submitted,
    count(*) FILTER(WHERE created_at < clock_timestamp()-${threshold}*interval '1 second') AS overdue,
    count(*) FILTER(WHERE coalesce(last_observation,'') IN ('INTEGRITY_MISMATCH','LEDGER_RESET','SEQUENCE_CONSUMED','TRANSACTION_ALREADY_BOUND')) AS quarantined,
    count(*) FILTER(WHERE broadcast_attempts>=${MAX_BROADCASTS}) AS "retryBudgetExhausted",
    count(*) FILTER(WHERE lease_expires_at>clock_timestamp()) AS "activeLeases",
    coalesce(floor(extract(epoch FROM clock_timestamp()-min(created_at))),0) AS "oldestAgeSeconds"
    FROM xrpl_payments WHERE chain='xrpl' AND network=${network} AND state IN ('prepared','signed','submitted')`);
  });
  const resultRows=rows as unknown as Record<string,unknown>[]|{rows:Record<string,unknown>[]};
  const row=(Array.isArray(resultRows)?resultRows[0]:resultRows.rows[0]) as Record<keyof PendingSummary,unknown>;
  const result={} as PendingSummary;
  for(const key of ["prepared","signed","submitted","overdue","quarantined","retryBudgetExhausted","activeLeases","oldestAgeSeconds"] as const){const value=Number(row?.[key]);if(!Number.isSafeInteger(value)||value<0)throw new Error("Invalid monitor aggregate");result[key]=value;}
  return result;
}
export async function collectOperations(settings:MonitorConfig,env:NodeJS.ProcessEnv=process.env):Promise<OperationsSnapshot> {
  const snapshot=initialSnapshot(settings.enabled,settings.network);snapshot.submission=submissionAvailability(env);
  if(!settings.enabled)return snapshot;
  const xrpl=readXrplConfig(env),endpoints=xrpl.endpoints;
  snapshot.network=xrpl.network;
  // One endpoint per probe, on the configured network (mainnet endpoints come from XRPL_MAINNET_WS).
  const only=(endpoint:string)=>xrpl.network==="mainnet"?{...env,XRPL_MAINNET_WS:endpoint}:{...env,XRPL_RPC_URLS:endpoint};
  const checks=await Promise.allSettled([pendingSummary(settings.pendingSeconds,xrpl.network),...endpoints.map(async(endpoint,id):Promise<EndpointSummary>=>{
    try {const health=await new XrplReadAdapter(only(endpoint)).getHealth();if(health.status!=="healthy")return {id,status:"unavailable"};return {id,status:"healthy",validatedLedgerIndex:health.validatedLedgerIndex};}
    catch {return {id,status:"unavailable"};}
  })]);
  snapshot.checkedAt=new Date().toISOString();
  if(checks[0].status==="fulfilled")snapshot.pending=checks[0].value as PendingSummary;
  snapshot.endpoints=checks.slice(1).map((check,id)=>check.status==="fulfilled"?check.value as EndpointSummary:{id,status:"unavailable"});
  snapshot.status=!snapshot.pending||!snapshot.endpoints.some(endpoint=>endpoint.status==="healthy")?"unavailable":snapshot.pending.overdue||snapshot.pending.quarantined||snapshot.pending.retryBudgetExhausted||snapshot.submission.code==="XRPL_CONTROL_UNAVAILABLE"||snapshot.endpoints.some(endpoint=>endpoint.status!=="healthy")?"degraded":"healthy";
  return snapshot;
}

export interface MonitorEvent {event:"xrpl_operations_alert"|"xrpl_operations_recovered";status:OperationsSnapshot["status"];overdue:number|null;quarantined:number|null;retryBudgetExhausted:number|null;unavailableEndpoints:number}
export function startXrplMonitor(settings:MonitorConfig,log:(event:MonitorEvent)=>void,collect=()=>collectOperations(settings)) {
  let snapshot=initialSnapshot(settings.enabled,settings.network),stopped=false,timer:ReturnType<typeof setTimeout>|undefined,active:Promise<void>=Promise.resolve(),lastKey="",lastAlert=0;
  async function tick(){
    try {snapshot=await collect();}catch {snapshot={...initialSnapshot(true,settings.network),status:"unavailable",checkedAt:new Date().toISOString()};}
    if(stopped)return;
    const unhealthy=["degraded","unavailable"].includes(snapshot.status);
    // Alert on a change in kind of problem, not in its size: counts move every tick under load.
    const present=(count:number|undefined)=>count===undefined?null:count>0;
    const key=JSON.stringify([snapshot.status,present(snapshot.pending?.overdue),present(snapshot.pending?.quarantined),present(snapshot.pending?.retryBudgetExhausted),snapshot.endpoints.map(endpoint=>endpoint.status)]);
    if((unhealthy&&(key!==lastKey||Date.now()-lastAlert>=900000))||(!unhealthy&&lastKey&&lastKey!=="healthy")){
      try{log({event:unhealthy?"xrpl_operations_alert":"xrpl_operations_recovered",status:snapshot.status,overdue:snapshot.pending?.overdue??null,quarantined:snapshot.pending?.quarantined??null,retryBudgetExhausted:snapshot.pending?.retryBudgetExhausted??null,unavailableEndpoints:snapshot.endpoints.filter(endpoint=>endpoint.status==="unavailable").length});}catch{}lastAlert=Date.now();
    }
    lastKey=unhealthy?key:"healthy";
    if(!stopped)timer=setTimeout(()=>{active=tick();},settings.intervalMs);
  }
  if(settings.enabled)active=tick();
  return {getSnapshot:()=>structuredClone(snapshot),stop:async()=>{stopped=true;if(timer)clearTimeout(timer);await active;}};
}

export type { MonitorConfig } from "./config";
