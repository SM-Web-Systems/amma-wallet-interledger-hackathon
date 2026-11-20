import type {RecoveryConfig} from "./config";
import {XrplPaymentService} from "./payment-service";

type Service=Pick<XrplPaymentService,"reconcileBatch">;
export function startXrplRecoveryWorker(settings:RecoveryConfig,mayBroadcast:()=>boolean,log:(event:{event:string;processed?:number})=>void=()=>{},factory:()=>Service=()=>new XrplPaymentService()):()=>Promise<void>{
  if(!settings.enabled)return async()=>{};
  const controller=new AbortController(),service=factory();let timer:ReturnType<typeof setTimeout>|undefined;
  async function tick():Promise<void>{
    if(controller.signal.aborted)return;
    try{const processed=await service.reconcileBatch(settings.batchSize,mayBroadcast(),controller.signal);if(processed)log({event:"xrpl_reconciliation_batch",processed});}
    catch{log({event:"xrpl_reconciliation_unavailable"});}
    finally{if(!controller.signal.aborted)timer=setTimeout(()=>{active=tick();},settings.intervalMs);}
  }
  let active=tick();
  return async()=>{controller.abort();if(timer)clearTimeout(timer);await active;};
}
