import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve,basename} from "node:path";
import {randomUUID} from "node:crypto";
import {it,expect,vi} from "vitest";
import {PGlite} from "@electric-sql/pglite";
import {drizzle} from "drizzle-orm/pglite";
import {Wallet,decode,hashes} from "xrpl";
import {legacyDatabase,migrate} from "../../db/migrations/chain-storage.test-support";
import {applyPaymentStorage} from "../../db/migrations/xrpl-payments";
import {applyReconciliationStorage} from "../../db/migrations/xrpl-reconciliation";
import {applyIntegrationStorage} from "../../db/migrations/xrpl-integration";
import type {AttemptInspection,ReconciliationEvidence} from "./reconciliation-adapter";
const state=vi.hoisted(()=>({db:undefined as any}));
vi.mock("../../db",async()=>({get db(){return state.db;},schema:await import("../../db/schema")}));
import {XrplPaymentService} from "./payment-service";

it("reopens file-backed payment/lease records and a fresh worker resumes the same signed hash",async()=>{
  const root=resolve(tmpdir()),directory=await mkdtemp(join(root,"amma-xrpl-m6-"));let pg:PGlite|undefined;
  try{
    pg=await legacyDatabase(directory);await migrate(pg);
    for(const apply of [applyPaymentStorage,applyReconciliationStorage,applyIntegrationStorage])await pg.transaction(tx=>apply({execute:async statement=>{await tx.exec(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>(await tx.query<T>(statement)).rows}));
    state.db=drizzle(pg);
    const source=Wallet.generate(),dest=Wallet.generate(),hash="A".repeat(64);
    await pg.query("INSERT INTO user_wallets(id,user_id,name,public_key,chain,network) VALUES (1,1,'Restart',$1,'xrpl','testnet')",[source.classicAddress]);
    const ledger=()=>({chain:"xrpl" as const,network:"testnet" as const,endpoint:"wss://testnet.xrpl-labs.com/",validatedLedgerIndex:1234,validatedLedgerHash:hash,observedAt:new Date().toISOString()});
    let delivered=false,saved="";
    const network={getAccount:vi.fn(async(address:string)=>({...ledger(),address,funded:true,balanceDrops:"9000000",reserveDrops:"1000000",spendableDrops:"8000000",sequence:7,ownerCount:0,requiresDestinationTag:false})),getFee:vi.fn(async()=>({...ledger(),feeDrops:"12",currentLedgerIndex:1235})),getHealth:vi.fn(),lookupTransaction:vi.fn(),
      inspectAttempt:vi.fn(async(input:AttemptInspection):Promise<ReconciliationEvidence>=>({...ledger(),minLedger:input.minLedger,maxLedger:input.lastLedgerSequence,anchorHash:input.anchorHash,...(delivered?{status:"validated" as const,code:"VALIDATED_TRANSACTION",transaction:{...ledger(),status:"validated" as const,validated:true as const,transactionHash:hashes.hashSignedTx(saved),ledgerIndex:1234,ledgerHash:hash,resultCode:"tesSUCCESS",transaction:decode(saved),metadata:{TransactionResult:"tesSUCCESS",delivered_amount:"1000000"}}}:{status:"open" as const,code:"AWAITING_LEDGER_BOUND"})})),
      submitSigned:vi.fn(async(blob:string)=>{saved=blob;delivered=true;return {provisionalResult:"tesSUCCESS"};})};
    const api=new XrplPaymentService(network,()=>{}),created=await api.create(1,{schemaVersion:1,walletId:"1",chain:"xrpl",network:"testnet",destination:dest.classicAddress,amountDrops:"1000000",maxFeeDrops:"100",reference:randomUUID()},randomUUID()),prepared=await api.prepare(1,created.id);
    const signed=source.sign(prepared.preparation!.unsignedTransaction);network.inspectAttempt.mockRejectedValueOnce(new Error("interrupted before broadcast"));
    await api.submit(1,created.id,prepared.preparation!.preparationId,signed.tx_blob);
    const token=randomUUID();await pg.query("UPDATE xrpl_payments SET lease_token=$1,lease_expires_at=now()+interval '120 seconds',next_reconcile_at=now()",[token]);
    await pg.close();pg=new PGlite(directory);state.db=drizzle(pg);
    const restarted=new XrplPaymentService(network,()=>{});expect(await restarted.reconcileBatch(1,true)).toBe(0);
    expect((await pg.query<{lease_token:string}>("SELECT lease_token FROM xrpl_payments")).rows[0].lease_token).toBe(token);
    await pg.exec("UPDATE xrpl_payments SET lease_expires_at=now()-interval '1 second'");expect(await restarted.reconcileBatch(1,true)).toBe(1);
    expect(network.submitSigned).toHaveBeenCalledTimes(1);expect(network.submitSigned.mock.calls[0][0]).toBe(signed.tx_blob);
    expect((await restarted.receipt(1,created.id)).transactionHash).toBe(signed.hash);
  }finally{
    await pg?.close();
    // Only remove the exact fresh test directory inside the resolved temp root.
    if(dirname(resolve(directory))!==root||!basename(directory).startsWith("amma-xrpl-m6-"))throw new Error("Refusing unexpected cleanup path");
    await rm(directory,{recursive:true,force:true});
  }
},90000);
