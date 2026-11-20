import {randomUUID} from "node:crypto";
import {and,asc,eq,notInArray,sql} from "drizzle-orm";
import {encode,type Payment} from "xrpl";
import {db,schema} from "../../db";
import {XrplReadError} from "./validation";
import type {XrplNetwork} from "./config";
import {PaymentError,observedSignedBlob,parseIntent,rowNetwork,referenceMemo,requestDigest,transactionDigest,uuid,validateSigned,verifySettlement,type Preparation} from "./payment";
import {historyCovers,XrplReconciliationAdapter,type ReconciliationEvidence} from "./reconciliation-adapter";

export type RecoveryNetwork=Pick<XrplReconciliationAdapter,"getAccount"|"getFee"|"getHealth"|"submitSigned"|"lookupTransaction"|"inspectAttempt">;
type Row=typeof schema.xrplPayments.$inferSelect;
type Tx=Parameters<Parameters<typeof db.transaction>[0]>[0];
const table=schema.xrplPayments;
export const LEASE_SECONDS=120;
export const MAX_BROADCASTS=8;
/** Codes from the submission gate, raised before any RPC send. */
export const SEND_GATE_CODES:readonly string[]=["XRPL_PAYMENTS_DISABLED","XRPL_SUBMISSION_PAUSED","XRPL_CONTROL_UNAVAILABLE"];
export const isTerminal=(row:Row)=>["validated_success","validated_failure","expired","cancelled"].includes(row.state);
const quarantined=(row:Row)=>["INTEGRITY_MISMATCH","LEDGER_RESET","SEQUENCE_CONSUMED","TRANSACTION_ALREADY_BOUND"].includes(row.lastObservation??"");
const pending=sql`${table.state} IN ('prepared','signed','submitted')`;
const namespace=(net:XrplNetwork)=>and(eq(table.chain,"xrpl"),eq(table.network,net));
const available=sql`(${table.leaseExpiresAt} IS NULL OR ${table.leaseExpiresAt}<=clock_timestamp())`;
const notQuarantined=sql`coalesce(${table.lastObservation},'') NOT IN ('INTEGRITY_MISMATCH','LEDGER_RESET','SEQUENCE_CONSUMED','TRANSACTION_ALREADY_BOUND')`;
const fenced=(row:Row)=>and(eq(table.id,row.id),eq(table.userId,row.userId),namespace(rowNetwork(row)),pending,eq(table.leaseToken,row.leaseToken!),sql`${table.leaseExpiresAt}>clock_timestamp()`);
const preparation=(row:Row)=>{
  try{
    if(!row.preparation||!row.preparationId)throw new Error();
    const p=row.preparation as Preparation,input=parseIntent(row.request,rowNetwork(row));
    if(p.preparationId!==row.preparationId||requestDigest(input)!==row.requestDigest||input.reference!==row.reference||input.walletId!==String(row.walletId)||!Number.isInteger(p.sequence)||p.sequence<1||p.sequence>0xffffffff||!Number.isInteger(p.validatedLedgerIndex)||p.validatedLedgerIndex<1||!Number.isInteger(p.lastLedgerSequence)||p.lastLedgerSequence<=p.validatedLedgerIndex||p.lastLedgerSequence>p.validatedLedgerIndex+24||!/^[A-F0-9]{64}$/.test(p.validatedLedgerHash)||! /^[1-9]\d{0,3}$/.test(p.feeDrops)||BigInt(p.feeDrops)>BigInt(input.maxFeeDrops)||p.totalDrops!==(BigInt(input.amountDrops)+BigInt(p.feeDrops)).toString())throw new Error();
    const expected:Payment={TransactionType:"Payment",Account:row.source,Destination:input.destination,Amount:input.amountDrops,...(input.destinationTag===undefined?{}:{DestinationTag:input.destinationTag}),Flags:0x80000000,Fee:p.feeDrops,Sequence:p.sequence,LastLedgerSequence:p.lastLedgerSequence,Memos:referenceMemo(input.reference)};
    if(encode(expected)!==p.unsignedBlob||encode(p.unsignedTransaction)!==p.unsignedBlob||transactionDigest(p.unsignedBlob,input.network)!==p.transactionDigest)throw new Error();
    return p;
  }catch{throw new PaymentError("INTEGRITY_MISMATCH",503);}
};
async function audit(tx:Tx,row:Row,to:string,code:string){await tx.insert(schema.xrplPaymentEvents).values({intentId:row.id,fromState:row.state,toState:to,code});}
export function retryDelay(failures:number):number{return Math.min(900,15*2**Math.min(Math.max(failures-1,0),6));}
export function broadcastDelay(attempts:number):number{return Math.min(300,15*2**Math.min(Math.max(attempts-1,0),5));}

export class XrplReconciler {
  constructor(private readonly network:RecoveryNetwork=new XrplReconciliationAdapter(),private readonly net:XrplNetwork="testnet"){}
  private async read(owner:number,id:string):Promise<Row>{
    const [row]=await db.select().from(table).where(and(namespace(this.net),eq(table.userId,owner),eq(table.id,id)));
    if(!row)throw new PaymentError("PAYMENT_NOT_FOUND",404);return row;
  }
  private async claim(owner?:number,id?:string,excluded:string[]=[]):Promise<Row|null>{
    return db.transaction(async tx=>{
      const where=and(namespace(this.net),pending,available,notQuarantined,
        owner===undefined?undefined:eq(table.userId,owner),id===undefined?sql`${table.nextReconcileAt}<=clock_timestamp()`:eq(table.id,id),
        excluded.length?notInArray(table.id,excluded):undefined);
      const [row]=await tx.select().from(table).where(where).orderBy(asc(table.nextReconcileAt),asc(table.createdAt)).limit(1).for("update",{skipLocked:true});
      if(!row)return null;
      const [claimed]=await tx.update(table).set({leaseToken:randomUUID(),leaseExpiresAt:sql`clock_timestamp()+${LEASE_SECONDS}*interval '1 second'`,reconcileAttempts:sql`least(${table.reconcileAttempts}::bigint+1,2147483647)`}).where(eq(table.id,row.id)).returning();
      return claimed;
    });
  }
  /** The token plus database-clock expiry fences all outcome/counter writes. */
  private async save(row:Row,patch:Partial<Row>,code:string,evidence:ReconciliationEvidence|undefined,finish:boolean,failed=false):Promise<Row|null>{
    return db.transaction(async tx=>{
      const [current]=await tx.select().from(table).where(fenced(row)).for("update");if(!current||quarantined(current))return null;
      const failures=failed?Math.min(current.reconcileFailures+1,30):0;
      const checkpoint=evidence&&evidence.validatedLedgerIndex>=(current.lastCheckedLedger??0)?{lastCheckedLedger:evidence.validatedLedgerIndex,lastCheckedLedgerHash:evidence.validatedLedgerHash}:{};
      const {transaction:_transaction,...proof}=evidence??{};
      const [updated]=await tx.update(table).set({...patch,...checkpoint,lastObservation:code,
        ...(evidence?{reconciliationEvidence:proof}:{}),reconcileFailures:failures,updatedAt:sql`clock_timestamp()`,
        ...(finish?{leaseToken:null,leaseExpiresAt:null,nextReconcileAt:sql`clock_timestamp()+${failed?retryDelay(failures):15}*interval '1 second'`}:{}),
      }).where(fenced(row)).returning();
      if(updated&&(current.state!==updated.state||["INTEGRITY_MISMATCH","LEDGER_RESET","SEQUENCE_CONSUMED","TRANSACTION_ALREADY_BOUND"].includes(code)))await audit(tx,current,updated.state,code);
      return updated??null;
    });
  }
  private async reserveBroadcast(row:Row):Promise<Row|null>{
    return db.transaction(async tx=>{
      const [current]=await tx.select().from(table).where(and(fenced(row),notQuarantined)).for("update");
      if(!current||!current.signedBlob||!current.transactionHash||current.broadcastAttempts>=MAX_BROADCASTS)return null;
      const [eligible]=await tx.select({id:table.id}).from(table).where(and(eq(table.id,current.id),sql`(${table.lastBroadcastAt} IS NULL OR ${table.lastBroadcastAt}+${broadcastDelay(current.broadcastAttempts)}*interval '1 second'<=clock_timestamp())`));
      if(!eligible)return null;
      const [updated]=await tx.update(table).set({broadcastAttempts:current.broadcastAttempts+1,lastBroadcastAt:sql`clock_timestamp()`}).where(fenced(row)).returning();
      if(updated)await audit(tx,current,current.state,"BROADCAST_ATTEMPT_RESERVED");return updated??null;
    });
  }
  // The send gate (pause/control file) refused before anything reached the
  // network, so the reserved attempt was never used: give it back.
  private async releaseBroadcast(before:Row,reserved:Row):Promise<void>{
    await db.transaction(async tx=>{
      const [released]=await tx.update(table).set({broadcastAttempts:before.broadcastAttempts,lastBroadcastAt:before.lastBroadcastAt})
        .where(and(fenced(reserved),eq(table.broadcastAttempts,reserved.broadcastAttempts))).returning();
      if(released)await audit(tx,reserved,reserved.state,"BROADCAST_ATTEMPT_RELEASED");
    });
  }
  private assertExpiry(row:Row,evidence:ReconciliationEvidence){
    const p=preparation(row);
    if(evidence.status!=="expired"||evidence.code!=="NON_INCLUSION_PROVEN"||evidence.chain!=="xrpl"||evidence.network!==this.net||evidence.minLedger!==p.validatedLedgerIndex||evidence.maxLedger!==p.lastLedgerSequence||evidence.anchorHash!==p.validatedLedgerHash||evidence.validatedLedgerIndex<=p.lastLedgerSequence||!historyCovers(evidence.completeLedgers,p.validatedLedgerIndex,p.lastLedgerSequence)||evidence.sequenceAtBound!==p.sequence||evidence.currentSequence!==p.sequence||(row.transactionHash&&evidence.searchedAll!==true)||!Number.isFinite(Date.parse(evidence.observedAt))||Math.abs(Date.now()-Date.parse(evidence.observedAt))>30000)throw new PaymentError("INTEGRITY_MISMATCH",503);
  }
  private async observe(row:Row,evidence:ReconciliationEvidence,finish:boolean):Promise<"done"|"open">{
    const p=preparation(row),input=parseIntent(row.request,rowNetwork(row));
    if(evidence.chain!=="xrpl"||evidence.network!==this.net||evidence.minLedger!==p.validatedLedgerIndex||evidence.maxLedger!==p.lastLedgerSequence||evidence.anchorHash!==p.validatedLedgerHash)throw new PaymentError("INTEGRITY_MISMATCH",503);
    if(row.lastCheckedLedger===evidence.validatedLedgerIndex&&row.lastCheckedLedgerHash&&row.lastCheckedLedgerHash!==evidence.validatedLedgerHash)throw new XrplReadError("LEDGER_RESET");
    if(evidence.status==="validated"){
      if(!evidence.transaction||evidence.transaction.status!=="validated")throw new PaymentError("INTEGRITY_MISMATCH",503);
      let blob=row.signedBlob,hash=row.transactionHash;
      if(!hash){
        try{const recovered=validateSigned(observedSignedBlob(evidence.transaction.transaction),p,input,row.source);blob=recovered.blob;hash=recovered.hash;}
        catch{await this.save(row,{},"SEQUENCE_CONSUMED",evidence,true);return "done";}
      }
      const settlement=verifySettlement(row.id,input,row.source,p,hash,evidence.transaction);
      if(!settlement)throw new PaymentError("INTEGRITY_MISMATCH",503);
      await this.save(row,{state:settlement.state,signedBlob:blob,transactionHash:hash,receipt:settlement.receipt,resultCode:settlement.resultCode},"VALIDATED",evidence,true);return "done";
    }
    if(evidence.status==="expired"){
      this.assertExpiry(row,evidence);await this.save(row,{state:"expired",receipt:null,resultCode:null},"NON_INCLUSION_PROVEN",evidence,true);return "done";
    }
    if(evidence.status==="unresolved"){
      const code=evidence.code==="SEQUENCE_CONSUMED"?"SEQUENCE_CONSUMED":"HISTORY_UNAVAILABLE";
      await this.save(row,{},code,evidence,true,code!=="SEQUENCE_CONSUMED");return "done";
    }
    if(evidence.status!=="open")throw new PaymentError("INTEGRITY_MISMATCH",503);
    if(finish)await this.save(row,{},row.broadcastAttempts>=MAX_BROADCASTS?"RETRY_BUDGET_EXHAUSTED":evidence.code,evidence,true);
    return "open";
  }
  private async process(row:Row,allowBroadcast:boolean,signal?:AbortSignal):Promise<void>{
    try{
      const p=preparation(row),input=parseIntent(row.request,rowNetwork(row));
      if(row.signedBlob||row.transactionHash){
        const signed=validateSigned(row.signedBlob,p,input,row.source);
        if(signed.hash!==row.transactionHash)throw new PaymentError("INTEGRITY_MISMATCH",503);
      }
      const inspect=()=>this.network.inspectAttempt({source:row.source,sequence:p.sequence,minLedger:p.validatedLedgerIndex,anchorHash:p.validatedLedgerHash,lastLedgerSequence:p.lastLedgerSequence,hash:row.transactionHash,...(row.lastCheckedLedger&&row.lastCheckedLedgerHash?{checkpoint:{index:row.lastCheckedLedger,hash:row.lastCheckedLedgerHash}}:{})});
      const evidence=await inspect();
      if(await this.observe(row,evidence,false)==="done")return;
      if(allowBroadcast&&!signal?.aborted&&row.signedBlob&&evidence.code!=="TRANSACTION_PENDING"&&Math.max(evidence.validatedLedgerIndex,row.lastCheckedLedger??0)<=p.lastLedgerSequence){
        const reserved=await this.reserveBroadcast(row);
        if(reserved){
          if(signal?.aborted){await this.save(row,{},"RECOVERY_STOPPED",evidence,true);return;}
          try{
            await this.network.submitSigned(reserved.signedBlob!,p.lastLedgerSequence,{index:evidence.validatedLedgerIndex,hash:evidence.validatedLedgerHash});
            const updated=await this.save(row,{state:"submitted"},"BROADCAST_ACKNOWLEDGED",evidence,false);if(!updated)return;
            row=updated;
          }catch(cause){
            if(cause instanceof XrplReadError&&cause.code==="LEDGER_RESET")throw cause;
            if(cause instanceof PaymentError&&SEND_GATE_CODES.includes(cause.code)){
              await this.releaseBroadcast(row,reserved);await this.save(row,{},cause.code,evidence,true);return;
            }
            await this.save(row,{},"BROADCAST_UNRESOLVED",evidence,true,true);return;
          }
          await this.observe(row,await inspect(),true);return;
        }
      }
      await this.observe(row,evidence,true);
    }catch(cause){
      const pg=cause as {code?:string;cause?:{code?:string}};
      const code=pg?.code==="23505"||pg?.cause?.code==="23505"?"TRANSACTION_ALREADY_BOUND":cause instanceof PaymentError&&["INTEGRITY_MISMATCH","SIGNED_TRANSACTION_MISMATCH"].includes(cause.code)?"INTEGRITY_MISMATCH":cause instanceof XrplReadError&&["LEDGER_RESET","HISTORY_UNAVAILABLE"].includes(cause.code)?cause.code:"LOOKUP_UNAVAILABLE";
      await this.save(row,{},code,undefined,true,! ["INTEGRITY_MISMATCH","LEDGER_RESET","TRANSACTION_ALREADY_BOUND"].includes(code));
    }
  }
  async reconcile(owner:number,id:string,allowBroadcast=false):Promise<Row>{
    return (await this.attempt(owner,id,allowBroadcast)).row;
  }
  /** Like reconcile, but also reports whether this call held the lease. A pending
   * row whose lease another (possibly dead) process holds was not processed. */
  async attempt(owner:number,id:string,allowBroadcast=false):Promise<{row:Row;processed:boolean}>{
    uuid(id);await this.read(owner,id);
    const claimed=await this.claim(owner,id);if(claimed)await this.process(claimed,allowBroadcast);
    return {row:await this.read(owner,id),processed:!!claimed};
  }
  async runDue(limit=10,allowBroadcast=false,signal?:AbortSignal):Promise<number>{
    if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error("Invalid reconciliation batch size");
    const ids:string[]=[];
    for(let i=0;i<limit&&!signal?.aborted;i++){
      const row=await this.claim(undefined,undefined,ids);if(!row)break;ids.push(row.id);await this.process(row,allowBroadcast,signal);
    }
    return ids.length;
  }
}
