import { XrplPaymentAdapter } from "./payment-adapter";
import type { LedgerObservation, TransactionObservation } from "./read-adapter";
import { classicAddress, object, transactionHash, uint, XrplReadError } from "./validation";

export interface AttemptInspection {
  source: string; sequence: number; minLedger: number; anchorHash: string; lastLedgerSequence: number; hash: string | null;
  checkpoint?: {index:number;hash:string};
}
export interface ReconciliationEvidence extends LedgerObservation {
  status: "open" | "expired" | "validated" | "unresolved";
  code: string; minLedger: number; maxLedger: number; anchorHash: string;
  completeLedgers?: string; searchedAll?: boolean; pages?: number; scanned?: number;
  sequenceAtBound?: number; currentSequence?: number;
  transaction?: TransactionObservation;
}
export function historyCovers(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string" || value.length > 4096 || value === "empty") return false;
  const ranges: [number,number][] = [];
  for (const part of value.split(",")) {
    const match=/^([1-9]\d{0,9})(?:-([1-9]\d{0,9}))?$/.exec(part);
    if (!match) return false;
    const low=Number(match[1]), high=Number(match[2]??match[1]);
    if (high<low||high>0xffffffff) return false;
    ranges.push([low,high]);
  }
  ranges.sort((a,b)=>a[0]-b[0]);let cursor=min;
  for(const [low,high] of ranges){if(high<cursor)continue;if(low>cursor)return false;cursor=Math.max(cursor,high+1);if(cursor>max)return true;}
  return false;
}
function errorData(cause: unknown): Record<string,unknown> {
  return cause&&typeof cause==="object"&&"data" in cause?object(cause.data):{};
}

/** All expiry evidence comes from one fresh, lineage-checked Testnet session. */
export class XrplReconciliationAdapter extends XrplPaymentAdapter {
  protected stopRetry(cause: unknown): boolean { return cause instanceof XrplReadError&&cause.code==="LEDGER_RESET" || super.stopRetry(cause); }
  async inspectAttempt(input: AttemptInspection): Promise<ReconciliationEvidence> {
    const source=classicAddress(input.source), sequence=uint(input.sequence,true), min=uint(input.minLedger,true), max=uint(input.lastLedgerSequence,true), anchorHash=transactionHash(input.anchorHash);
    if(max<=min||max-min>24)throw new XrplReadError("INVALID_LEDGER_RESPONSE");
    const hash=input.hash===null?null:transactionHash(input.hash);
    const checkpoint=input.checkpoint?{index:uint(input.checkpoint.index,true),hash:transactionHash(input.checkpoint.hash)}:undefined;
    if(checkpoint&&checkpoint.index<min)throw new XrplReadError("INVALID_LEDGER_RESPONSE");
    return this.withEndpoint(async(read,ledger,_submit,info)=>{
      const base={...ledger,minLedger:min,maxLedger:max,anchorHash};
      // A lagging endpoint alone does not prove a reset. Require continuity
      // before doing anything; a changed hash at the known index proves drift.
      if(ledger.validatedLedgerIndex<min)throw new XrplReadError("STALE_LEDGER",true);
      let anchor:Record<string,unknown>;
      try{anchor=await read({command:"ledger",ledger_index:min,transactions:false,expand:false});}
      catch(cause){if(["lgrNotFound","lgrIdxMalformed"].includes(String(errorData(cause).error)))throw new XrplReadError("HISTORY_UNAVAILABLE",true);throw cause;}
      if(anchor.validated!==true||uint(anchor.ledger_index,true)!==min)throw new XrplReadError("HISTORY_UNAVAILABLE",true);
      if(transactionHash(anchor.ledger_hash)!==anchorHash)throw new XrplReadError("LEDGER_RESET");
      if(checkpoint){
        if(ledger.validatedLedgerIndex<checkpoint.index)throw new XrplReadError("STALE_LEDGER",true);
        const previous=checkpoint.index===ledger.validatedLedgerIndex?{validated:true,ledger_index:ledger.validatedLedgerIndex,ledger_hash:ledger.validatedLedgerHash}:await read({command:"ledger",ledger_index:checkpoint.index,transactions:false,expand:false});
        if(previous.validated!==true||previous.ledger_index!==checkpoint.index)throw new XrplReadError("HISTORY_UNAVAILABLE",true);
        if(transactionHash(previous.ledger_hash)!==checkpoint.hash)throw new XrplReadError("LEDGER_RESET");
      }
      let searchedAll=false;
      if(hash){
        try{
          const tx=await read({command:"tx",transaction:hash,binary:false,min_ledger:min,max_ledger:max});
          const observation=await this.transactionObservation(read,ledger,tx,hash);
          if(observation.status==="validated")return {...base,status:"validated",code:"VALIDATED_TRANSACTION",transaction:observation};
          return {...base,status:"open",code:"TRANSACTION_PENDING",transaction:observation};
        }catch(cause){
          const data=errorData(cause);if(data.error!=="txnNotFound")throw cause;
          searchedAll=data.searched_all===true;
          if(data.request!==undefined){const request=object(data.request);if(request.min_ledger!==min||request.max_ledger!==max||request.transaction!==hash)throw new XrplReadError("INVALID_LEDGER_RESPONSE",true);}
        }
      }
      if(ledger.validatedLedgerIndex<=max)return {...base,status:"open",code:"AWAITING_LEDGER_BOUND",searchedAll};
      if(!historyCovers(info.complete_ledgers,min,max)||(hash!==null&&!searchedAll))throw new XrplReadError("HISTORY_UNAVAILABLE",true);
      let marker:unknown=undefined,scanned=0;const markers=new Set<string>();
      for(let page=1;page<=8;page++){
        const history=await read({command:"account_tx",account:source,ledger_index_min:min,ledger_index_max:max,forward:true,binary:false,limit:200,...(marker===undefined?{}:{marker})});
        if(history.account!==source||history.ledger_index_min!==min||history.ledger_index_max!==max||history.validated===false||!Array.isArray(history.transactions))throw new XrplReadError("HISTORY_UNAVAILABLE",true);
        if(history.transactions.length>200)throw new XrplReadError("INVALID_LEDGER_RESPONSE",true);
        for(const value of history.transactions){
          const entry=object(value),tx=object(entry.tx_json),index=uint(entry.ledger_index,true);
          if(entry.validated!==true||index<min||index>max||typeof tx.Account!=="string")throw new XrplReadError("HISTORY_UNAVAILABLE",true);
          scanned++;
          if(tx.Account===source&&uint(tx.Sequence)===sequence){
            const candidateHash=transactionHash(entry.hash);
            if(hash&&candidateHash!==hash)return {...base,status:"unresolved",code:"SEQUENCE_CONSUMED",completeLedgers:info.complete_ledgers as string,searchedAll,pages:page,scanned};
            const candidate=await read({command:"tx",transaction:candidateHash,binary:false,min_ledger:min,max_ledger:max});
            const observation=await this.transactionObservation(read,ledger,candidate,candidateHash);
            if(observation.status!=="validated")throw new XrplReadError("HISTORY_UNAVAILABLE",true);
            return {...base,status:"validated",code:"RECOVERED_SEQUENCE_TRANSACTION",transaction:observation,completeLedgers:info.complete_ledgers as string,pages:page,scanned};
          }
        }
        if(history.marker===undefined){
          const bound=await read({command:"account_info",account:source,ledger_index:max,strict:true});
          const current=await read({command:"account_info",account:source,ledger_hash:ledger.validatedLedgerHash,strict:true});
          if(bound.validated!==true||bound.ledger_index!==max||current.validated!==true||current.ledger_index!==ledger.validatedLedgerIndex||transactionHash(current.ledger_hash)!==ledger.validatedLedgerHash)throw new XrplReadError("HISTORY_UNAVAILABLE",true);
          // Bind the historical account response to that validated ledger too.
          const boundLedger=await read({command:"ledger",ledger_index:max,transactions:false,expand:false});
          if(boundLedger.validated!==true||boundLedger.ledger_index!==max||transactionHash(bound.ledger_hash)!==transactionHash(boundLedger.ledger_hash))throw new XrplReadError("HISTORY_UNAVAILABLE",true);
          const atBound=object(bound.account_data),atCurrent=object(current.account_data);
          if(atBound.Account!==source||atCurrent.Account!==source)throw new XrplReadError("INVALID_LEDGER_RESPONSE",true);
          const sequenceAtBound=uint(atBound.Sequence,true),currentSequence=uint(atCurrent.Sequence,true);
          const evidence={...base,completeLedgers:info.complete_ledgers as string,searchedAll,pages:page,scanned,sequenceAtBound,currentSequence};
          if(sequenceAtBound!==sequence||currentSequence!==sequence)return {...evidence,status:"unresolved",code:"SEQUENCE_CONSUMED"};
          return {...evidence,status:"expired",code:"NON_INCLUSION_PROVEN"};
        }
        const encoded=JSON.stringify(history.marker);
        if(!encoded||encoded.length>1024||markers.has(encoded))throw new XrplReadError("HISTORY_UNAVAILABLE",true);
        markers.add(encoded);marker=history.marker;
      }
      throw new XrplReadError("HISTORY_UNAVAILABLE",true);
    });
  }
}
