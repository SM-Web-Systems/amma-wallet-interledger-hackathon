import {randomUUID} from "node:crypto";
import {beforeAll,beforeEach,afterAll,describe,expect,it,vi} from "vitest";
import {Wallet,decode,hashes} from "xrpl";
import {drizzle} from "drizzle-orm/pglite";
import type {PGlite} from "@electric-sql/pglite";
import {legacyDatabase,migrate} from "../../db/migrations/chain-storage.test-support";
import {applyPaymentStorage} from "../../db/migrations/xrpl-payments";
import {applyReconciliationStorage} from "../../db/migrations/xrpl-reconciliation";
import {applyIntegrationStorage} from "../../db/migrations/xrpl-integration";
import {XrplReadError} from "./validation";
import {PaymentError} from "./payment";
import type {AttemptInspection,ReconciliationEvidence} from "./reconciliation-adapter";
import type {AccountSnapshot} from "./read-adapter";

const state=vi.hoisted(()=>({db:undefined as any}));
vi.mock("../../db",async()=>({get db(){return state.db;},schema:await import("../../db/schema")}));
import {XrplPaymentService} from "./payment-service";
import {XrplReconciler,retryDelay,broadcastDelay} from "./reconciler";

const source=Wallet.generate(),destination=Wallet.generate();const A="A".repeat(64),C="C".repeat(64);
let pg:PGlite,head:number,seenBlob:string,mode:"open"|"validated"|"expired"|"gap"|"reset"|"sequence",autoValidate:boolean;
const ledger=()=>({chain:"xrpl" as const,network:"testnet" as const,endpoint:"wss://testnet.xrpl-labs.com/",validatedLedgerIndex:head,validatedLedgerHash:head===1234?A:C,observedAt:new Date().toISOString()});
const account=(address:string):AccountSnapshot=>({...ledger(),address,funded:true,balanceDrops:"20000000",reserveDrops:"1000000",spendableDrops:"19000000",sequence:12,ownerCount:0,requiresDestinationTag:false});
const evidence=(input:AttemptInspection):ReconciliationEvidence=>{
  const base={...ledger(),minLedger:input.minLedger,maxLedger:input.lastLedgerSequence,anchorHash:input.anchorHash};
  if(mode==="gap")throw new XrplReadError("HISTORY_UNAVAILABLE",true);
  if(mode==="reset")throw new XrplReadError("LEDGER_RESET");
  if(mode==="sequence")return {...base,status:"unresolved",code:"SEQUENCE_CONSUMED"};
  if(mode==="expired")return {...base,status:"expired",code:"NON_INCLUSION_PROVEN",completeLedgers:`1-${head}`,searchedAll:true,pages:1,scanned:0,sequenceAtBound:input.sequence,currentSequence:input.sequence};
  if(mode==="validated")return {...base,status:"validated",code:"VALIDATED_TRANSACTION",transaction:{...ledger(),status:"validated",validated:true,transactionHash:hashes.hashSignedTx(seenBlob),ledgerIndex:1235,ledgerHash:C,resultCode:"tesSUCCESS",transaction:decode(seenBlob),metadata:{TransactionResult:"tesSUCCESS",delivered_amount:"1000000"}}};
  return {...base,status:"open",code:"AWAITING_LEDGER_BOUND"};
};
const network={
  getAccount:vi.fn(async(address:string)=>account(address)),getFee:vi.fn(async()=>({...ledger(),feeDrops:"12",currentLedgerIndex:head+1})),getHealth:vi.fn(async()=>({...ledger(),status:"healthy" as const})),
  lookupTransaction:vi.fn(),inspectAttempt:vi.fn(async(input:AttemptInspection)=>evidence(input)),
  submitSigned:vi.fn(async(blob:string)=>{seenBlob=blob;if(autoValidate)mode="validated";return {provisionalResult:"tesSUCCESS"};}),
};
const service=()=>new XrplPaymentService(network,()=>{});
const body=(walletId="1",reference=randomUUID())=>({schemaVersion:1,walletId,chain:"xrpl",network:"testnet",destination:destination.classicAddress,destinationTag:0,amountDrops:"1000000",maxFeeDrops:"100",reference});
async function prepared(owner=1,walletId="1",reference=randomUUID()){
  const api=service(),intent=await api.create(owner,body(walletId,reference),randomUUID());
  return api.prepare(owner,intent.id);
}
async function signedWithoutBroadcast(){
  const payment=await prepared(),signed=source.sign(payment.preparation!.unsignedTransaction);
  network.inspectAttempt.mockRejectedValueOnce(new Error("process/network interruption before broadcast"));
  const result=await service().submit(1,payment.id,payment.preparation!.preparationId,signed.tx_blob);
  expect(result.state).toBe("signed");expect(network.submitSigned).not.toHaveBeenCalled();
  seenBlob=signed.tx_blob;return {payment,signed};
}
async function due(){await pg.exec("UPDATE xrpl_payments SET next_reconcile_at=now()-interval '1 second'");}
async function row(id:string){return (await pg.query<Record<string,any>>("SELECT * FROM xrpl_payments WHERE id=$1",[id])).rows[0];}
beforeAll(async()=>{
  pg=await legacyDatabase();await migrate(pg);
  for(const apply of [applyPaymentStorage,applyReconciliationStorage,applyIntegrationStorage])await pg.transaction(tx=>apply({execute:async sql=>{await tx.exec(sql);},rows:async<T extends Record<string,unknown>>(sql:string)=>(await tx.query<T>(sql)).rows}));
  state.db=drizzle(pg);
},30000);
beforeEach(async()=>{
  head=1234;seenBlob="";mode="open";autoValidate=true;vi.clearAllMocks();
  network.inspectAttempt.mockReset().mockImplementation(async input=>evidence(input));
  network.submitSigned.mockReset().mockImplementation(async blob=>{seenBlob=blob;if(autoValidate)mode="validated";return {provisionalResult:"tesSUCCESS"};});
  await pg.exec(`TRUNCATE xrpl_receipt_claims,xrpl_payment_events,xrpl_payments,user_wallets RESTART IDENTITY;INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active) VALUES (1,1,'Source','${source.classicAddress}','xrpl','testnet',true),(2,2,'Shared source','${source.classicAddress}','xrpl','testnet',true);`);
});
afterAll(async()=>{await pg?.close();});

describe("durable XRP recovery with actual signed blobs and migrated database",()=>{
  it("a new service recovers a committed signed attempt before its first broadcast",async()=>{
    const {payment,signed}=await signedWithoutBroadcast();await due();
    expect(await service().reconcileBatch(10,true)).toBe(1);
    expect(network.submitSigned).toHaveBeenCalledTimes(1);expect(network.submitSigned.mock.calls[0][0]).toBe(signed.tx_blob);
    expect(await row(payment.id)).toMatchObject({state:"validated_success",transaction_hash:signed.hash,broadcast_attempts:1,lease_token:null});
  });
  it("recovers after broadcast without acknowledgment by observing the saved hash, not paying again",async()=>{
    const payment=await prepared(),signed=source.sign(payment.preparation!.unsignedTransaction);
    network.submitSigned.mockImplementationOnce(async blob=>{seenBlob=blob;throw new Error("ack lost after delivery");});
    expect((await service().submit(1,payment.id,payment.preparation!.preparationId,signed.tx_blob)).state).toBe("signed");
    mode="validated";await due();await service().reconcileBatch(10,true);
    expect(network.submitSigned).toHaveBeenCalledTimes(1);expect((await service().receipt(1,payment.id)).transactionHash).toBe(signed.hash);
  });
  it("does not broadcast if the signed-state transaction cannot commit",async()=>{
    const payment=await prepared(),signed=source.sign(payment.preparation!.unsignedTransaction);
    await pg.exec("CREATE FUNCTION reject_signed_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.to_state='signed' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER reject_signed_event BEFORE INSERT ON xrpl_payment_events FOR EACH ROW EXECUTE FUNCTION reject_signed_event();");
    try{await expect(service().submit(1,payment.id,payment.preparation!.preparationId,signed.tx_blob)).rejects.toThrow();expect(network.submitSigned).not.toHaveBeenCalled();expect(await row(payment.id)).toMatchObject({state:"prepared",signed_blob:null,transaction_hash:null});}
    finally{await pg.exec("DROP TRIGGER reject_signed_event ON xrpl_payment_events;DROP FUNCTION reject_signed_event()");}
  });
  it("workers skip an active lease; stale work cannot update or rebroadcast after reclamation",async()=>{
    const {payment,signed}=await signedWithoutBroadcast();await due();
    let began!:()=>void,release!:(value:ReconciliationEvidence)=>void;const started=new Promise<void>(resolve=>{began=resolve;});
    network.inspectAttempt.mockImplementationOnce(input=>new Promise(resolve=>{began();release=()=>resolve({...ledger(),minLedger:input.minLedger,maxLedger:input.lastLedgerSequence,anchorHash:input.anchorHash,status:"open",code:"AWAITING_LEDGER_BOUND"});}));
    const abandoned=service().reconcileBatch(1,true);await started;
    expect(await service().reconcileBatch(1,true)).toBe(0);
    const oldToken=(await row(payment.id)).lease_token;expect(oldToken).not.toBeNull();
    await pg.exec("UPDATE xrpl_payments SET lease_expires_at=now()-interval '1 second'");mode="validated";
    expect(await service().reconcileBatch(1,true)).toBe(1);release({} as any);await abandoned;
    expect(network.submitSigned).not.toHaveBeenCalled();expect(await row(payment.id)).toMatchObject({state:"validated_success",transaction_hash:signed.hash,lease_token:null});
  });
  it("fences an unsigned inspection when an approved signed attempt is accepted",async()=>{
    const payment=await prepared(),signed=source.sign(payment.preparation!.unsignedTransaction);
    let began!:()=>void,release!:(value:ReconciliationEvidence)=>void;const started=new Promise<void>(resolve=>{began=resolve;});
    network.inspectAttempt.mockImplementationOnce(()=>new Promise(resolve=>{began();release=resolve;}));
    const old=service().status(1,payment.id);await started;autoValidate=false;
    expect((await service().submit(1,payment.id,payment.preparation!.preparationId,signed.tx_blob)).state).toBe("submitted");
    head=1260;mode="expired";release(evidence({source:source.classicAddress,sequence:12,minLedger:1234,anchorHash:A,lastLedgerSequence:1254,hash:null}));await old;
    expect(await row(payment.id)).toMatchObject({state:"submitted",signed_blob:signed.tx_blob,transaction_hash:signed.hash});
  });
  it.each([false,true])("releases a proven expired attempt (signed=%s), retains evidence and requires a fresh intent",async signed=>{
    const payment=signed?(await signedWithoutBroadcast()).payment:await prepared();head=1260;mode="expired";await due();
    await service().reconcileBatch(10,true);const saved=await row(payment.id);
    expect(saved).toMatchObject({state:"expired",receipt:null,last_checked_ledger:1260,last_observation:"NON_INCLUSION_PROVEN"});expect(saved.reconciliation_evidence).toMatchObject({status:"expired",sequenceAtBound:12,currentSequence:12});
    await expect(service().receipt(1,payment.id)).rejects.toMatchObject({code:"RECEIPT_UNAVAILABLE",retryable:false});
    if(signed)expect((await service().rebroadcast(1,payment.id)).state).toBe("expired");
    expect(network.submitSigned).not.toHaveBeenCalled();expect((await prepared()).state).toBe("prepared");
  });
  it("recovers a matching transaction signed outside the API from an unsigned preparation",async()=>{
    const payment=await prepared();seenBlob=source.sign(payment.preparation!.unsignedTransaction).tx_blob;mode="validated";head=1260;
    expect((await service().status(1,payment.id)).state).toBe("validated_success");expect(network.submitSigned).not.toHaveBeenCalled();expect((await row(payment.id)).signed_blob).toBe(seenBlob);
  });
  it("does not bind one ledger transaction to two separately registered owners' intents",async()=>{
    const reference=randomUUID(),first=await prepared(1,"1",reference),second=await prepared(2,"2",reference);
    const signed=source.sign(first.preparation!.unsignedTransaction);seenBlob=signed.tx_blob;mode="validated";
    await service().status(1,first.id);const other=await service().status(2,second.id);
    expect(other).toMatchObject({state:"prepared",lastObservation:"TRANSACTION_ALREADY_BOUND",receipt:null});
    await expect(service().receipt(2,second.id)).rejects.toThrow("RECEIPT_UNAVAILABLE");expect(network.submitSigned).not.toHaveBeenCalled();
  });
  it.each(["gap","reset","sequence"] as const)("keeps %s unresolved and never automatically replaces it",async next=>{
    const {payment}=await signedWithoutBroadcast();mode=next;head=1260;await due();await service().reconcileBatch(10,true);
    const saved=await row(payment.id);expect(saved.state).toBe("signed");expect(saved.receipt).toBeNull();expect(network.submitSigned).not.toHaveBeenCalled();
    expect(saved.last_observation).toBe(next==="gap"?"HISTORY_UNAVAILABLE":next==="reset"?"LEDGER_RESET":"SEQUENCE_CONSUMED");
    expect(await service().reconcileBatch(10,true)).toBe(0);
  });
  it("rejects fabricated or partial expiry evidence",async()=>{
    const {payment}=await signedWithoutBroadcast();head=1260;mode="expired";network.inspectAttempt.mockImplementationOnce(async input=>({...evidence(input),searchedAll:false}));await due();
    await service().reconcileBatch(1,true);expect(await row(payment.id)).toMatchObject({state:"signed",last_observation:"INTEGRITY_MISMATCH",receipt:null});expect(network.submitSigned).not.toHaveBeenCalled();
  });
  it("tells a manual retry that recovery holds the payment instead of reporting a silent success",async()=>{
    const {payment}=await signedWithoutBroadcast();
    // A process that died mid-reconciliation leaves its lease until it expires.
    await pg.exec("UPDATE xrpl_payments SET lease_token=gen_random_uuid(),lease_expires_at=now()+interval '60 seconds'");
    await expect(service().rebroadcast(1,payment.id)).rejects.toMatchObject({code:"RECOVERY_IN_PROGRESS",status:409,retryable:true});
    expect(network.submitSigned).not.toHaveBeenCalled();
    expect((await service().status(1,payment.id)).state).toBe("signed");
  });
  it("bounds broadcasts across manual retries and workers, while continuing observation",async()=>{
    const {payment,signed}=await signedWithoutBroadcast();autoValidate=false;
    await service().rebroadcast(1,payment.id);await service().rebroadcast(1,payment.id);
    expect(network.submitSigned).toHaveBeenCalledTimes(1);
    await pg.exec("UPDATE xrpl_payments SET broadcast_attempts=8,last_broadcast_at=now()-interval '1 hour',next_reconcile_at=now()");
    await service().reconcileBatch(1,true);expect(network.submitSigned).toHaveBeenCalledTimes(1);
    expect(await row(payment.id)).toMatchObject({last_observation:"RETRY_BUDGET_EXHAUSTED",broadcast_attempts:8,state:"submitted"});
    mode="validated";expect((await service().status(1,payment.id)).transactionHash).toBe(signed.hash);expect((await service().receipt(1,payment.id)).validated).toBe(true);
  });
  it("does not spend broadcast attempts when submission is paused at the send gate",async()=>{
    const {payment}=await signedWithoutBroadcast();autoValidate=false;
    await pg.exec("UPDATE xrpl_payments SET last_broadcast_at=NULL,next_reconcile_at=now()");
    const before=await row(payment.id);
    network.submitSigned.mockImplementationOnce(async()=>{throw new PaymentError("XRPL_SUBMISSION_PAUSED",503,true);});
    await service().reconcileBatch(1,true);
    expect(network.submitSigned).toHaveBeenCalledTimes(1);
    expect(await row(payment.id)).toMatchObject({state:"signed",last_observation:"XRPL_SUBMISSION_PAUSED",broadcast_attempts:before.broadcast_attempts,last_broadcast_at:before.last_broadcast_at});
    expect((await row(payment.id)).reconcile_failures).toBeLessThanOrEqual(before.reconcile_failures);
  });
  it("returns the saved signed payment when a pause lands between commit and broadcast",async()=>{
    const payment=await prepared(),signed=source.sign(payment.preparation!.unsignedTransaction);
    let calls=0;const gate=()=>{calls+=1;if(calls>1)throw new PaymentError("XRPL_SUBMISSION_PAUSED",503,true);};
    const result=await new XrplPaymentService(network,gate).submit(1,payment.id,payment.preparation!.preparationId,signed.tx_blob);
    expect(result.state).toBe("signed");expect(network.submitSigned).not.toHaveBeenCalled();
    expect(await row(payment.id)).toMatchObject({state:"signed",transaction_hash:signed.hash});
  });
  it("can reconcile with the payment broadcast kill switch off",async()=>{
    const {payment}=await signedWithoutBroadcast();await due();await service().reconcileBatch(1,false);expect(network.submitSigned).not.toHaveBeenCalled();
    mode="validated";await due();await service().reconcileBatch(1,false);expect((await service().receipt(1,payment.id)).validated).toBe(true);
  });
  it("never rebroadcasts corrupted saved authorization material",async()=>{
    const {payment}=await signedWithoutBroadcast();await pg.exec("UPDATE xrpl_payments SET transaction_hash=repeat('A',64),next_reconcile_at=now()");
    await service().reconcileBatch(1,true);expect(await row(payment.id)).toMatchObject({state:"signed",last_observation:"INTEGRITY_MISMATCH"});expect(network.submitSigned).not.toHaveBeenCalled();
  });
  it("checks owner access and database invariants for expiry/lease records",async()=>{
    const payment=await prepared();await expect(service().status(2,payment.id)).rejects.toThrow("PAYMENT_NOT_FOUND");
    await expect(pg.exec("UPDATE xrpl_payments SET state='expired',reconciliation_evidence='{}'::jsonb")).rejects.toThrow();
    await expect(pg.exec("UPDATE xrpl_payments SET lease_token='00000000-0000-4000-8000-000000000000'")).rejects.toThrow();
    expect((await row(payment.id)).state).toBe("prepared");
  });
  it("has bounded exponential retry intervals",async()=>{
    expect([0,1,2,3,30].map(retryDelay)).toEqual([15,15,30,60,900]);expect([0,1,2,8].map(broadcastDelay)).toEqual([15,15,30,300]);
    await expect(new XrplReconciler(network).runDue(21)).rejects.toThrow();
  });
});
