import {beforeAll,beforeEach,afterAll,it,expect,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {fork,type ChildProcess} from "node:child_process";
import {resolve} from "node:path";
import postgres from "postgres";
import {drizzle} from "drizzle-orm/postgres-js";
import {Wallet} from "xrpl";
import {acceptanceUrl,bootstrapFixture} from "./database";
import {offlineNetwork,request} from "./fixtures";
const state=vi.hoisted(()=>({db:undefined as any}));
vi.mock("../src/db",async()=>({get db(){return state.db;},schema:await import("../src/db/schema")}));
import {XrplPaymentService} from "../src/modules/xrpl/payment-service";
import {verifyExistingStorage} from "../src/release/schema-verification";
import {validateSigned} from "../src/modules/xrpl/payment";
let pg:ReturnType<typeof postgres>,initialized=false;
const source=Wallet.generate();
beforeAll(async()=>{pg=postgres(acceptanceUrl(),{max:10,connection:{statement_timeout:10000}});await bootstrapFixture(pg);state.db=drizzle(pg);initialized=true;});
beforeEach(async()=>{
  if(!initialized)throw new Error("No owned fixture");
  await pg.unsafe("TRUNCATE xrpl_receipt_claims,xrpl_payment_events,xrpl_payments,user_wallets,tenant_api_keys,tenant_users,tenants RESTART IDENTITY");
  await pg`INSERT INTO user_wallets(id,user_id,name,public_key,chain,network) VALUES(1,1,'Owner fixture',${source.classicAddress},'xrpl','testnet'),(2,2,'Shared source fixture',${source.classicAddress},'xrpl','testnet')`;
  await pg.unsafe("INSERT INTO tenants(id,slug,name) VALUES(1,'acceptance','Acceptance application');INSERT INTO tenant_users(tenant_id,user_id) VALUES(1,1);INSERT INTO tenant_api_keys(id,tenant_id,name,key_hash,key_prefix) VALUES(1,1,'Offline fixture',repeat('a',64),'test')");
});
afterAll(async()=>{await pg?.end({timeout:5});});
const service=(network=offlineNetwork())=>new XrplPaymentService(network,()=>{});
const application={tenantId:1,keyId:1,name:"Acceptance application"};

it("serializes parallel idempotency/reference decisions across real PostgreSQL connections",async()=>{
  const api=service(),body=request(),key=randomUUID(),results=await Promise.all(Array.from({length:8},()=>api.create(1,body,key,application)));
  expect(new Set(results.map(row=>row.id)).size).toBe(1);expect((await pg`SELECT count(*)::int AS n FROM xrpl_payments`)[0].n).toBe(1);
  await expect(api.create(1,{...body,amountDrops:"2"},key,application)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
});
it("allows one simultaneous unsigned preparation for an owner/source",async()=>{
  const api=service(),a=await api.create(1,request(),randomUUID()),b=await api.create(1,request(),randomUUID());
  const results=await Promise.allSettled([api.prepare(1,a.id),api.prepare(1,b.id)]);
  expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
});
it("commits signed bytes before a separate connection sees broadcast and blocks a competing source owner",async()=>{
  let entered!:()=>void,release!:()=>void;const broadcasting=new Promise<void>(resolve=>{entered=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;});
  const network=offlineNetwork(async blob=>{
    const rows=await pg`SELECT state,signed_blob FROM xrpl_payments WHERE signed_blob=${blob}`;expect(rows[0]?.state).toBe("signed");entered();await finish;
  }),api=service(network);
  const a=await api.create(1,request(),randomUUID()),b=await api.create(2,request("2"),randomUUID());
  const pa=(await api.prepare(1,a.id)).preparation!,pb=(await api.prepare(2,b.id)).preparation!;
  const first=api.submit(1,a.id,pa.preparationId,source.sign(pa.unsignedTransaction).tx_blob);
  try{await broadcasting;await expect(api.submit(2,b.id,pb.preparationId,source.sign(pb.unsignedTransaction).tx_blob)).rejects.toMatchObject({code:"PAYMENT_UNRESOLVED"});}
  finally{release();await first;}
  expect((await pg`SELECT count(*)::int AS n FROM xrpl_payments WHERE signed_blob IS NOT NULL`)[0].n).toBe(1);
});
it("reclaims a persisted lease after SIGKILL and uses exactly the saved transaction after restart",async()=>{
  const api=service(),created=await api.create(1,request(),randomUUID()),prepared=await api.prepare(1,created.id),p=prepared.preparation!,signed=validateSigned(source.sign(p.unsignedTransaction).tx_blob,p,prepared,source.classicAddress);
  await pg`UPDATE xrpl_payments SET state='signed',signed_blob=${signed.blob},transaction_hash=${signed.hash},next_reconcile_at=now() WHERE id=${created.id}`;
  const spawn=(phase:string)=>fork(resolve("acceptance/recovery-child.ts"),[created.id],{execArgv:["--import","tsx"],env:{...process.env,XRPL_ACCEPTANCE_PHASE:phase},stdio:["ignore","pipe","pipe","ipc"]});
  const awaitEvent=(child:ChildProcess,event:string)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Recovery child timed out")),15000);child.on("message",message=>{if((message as {event?:string}).event===event){clearTimeout(timer);resolve();}});child.once("exit",code=>{if(code!==0){clearTimeout(timer);reject(new Error("Recovery child exited"));}});});
  let child=spawn("stall");
  try{
    await awaitEvent(child,"xrpl_acceptance_lease_claimed");expect((await pg`SELECT lease_token FROM xrpl_payments WHERE id=${created.id}`)[0].lease_token).toBeTruthy();
    const killed=new Promise<void>(resolve=>child.once("exit",()=>resolve()));child.kill("SIGKILL");await killed;
    expect(await api.reconcileBatch(1,true)).toBe(0);
    // Accelerate lease expiry only in this explicitly isolated test database.
    await pg`UPDATE xrpl_payments SET lease_expires_at=now()-interval '1 second' WHERE id=${created.id}`;
    child=spawn("recover");await awaitEvent(child,"xrpl_acceptance_recovered");
    const [row]=await pg`SELECT state,transaction_hash,broadcast_attempts,receipt FROM xrpl_payments WHERE id=${created.id}`;
    expect(row).toMatchObject({state:"validated_success",transaction_hash:signed.hash,broadcast_attempts:1});expect(row.receipt.transactionHash).toBe(signed.hash);
  }finally{if(child.exitCode===null&&!child.killed)child.kill("SIGKILL");}
});
it("verifies recognized migration schemas inside a PostgreSQL READ ONLY transaction",async()=>{
  await pg.begin(async tx=>{
    await tx.unsafe("SET TRANSACTION READ ONLY");
    const connection={execute:async(statement:string)=>{await tx.unsafe(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>Array.from(await tx.unsafe<T[]>(statement))};
    await verifyExistingStorage(connection);
    expect((await tx.unsafe("SHOW transaction_read_only"))[0].transaction_read_only).toBe("on");
  });
});
it("atomically consumes one validated payment for one purchase across concurrent connections",async()=>{
  const api=service(),created=await api.create(1,request(),randomUUID(),application),prepared=await api.prepare(1,created.id),p=prepared.preparation!;
  const payment=await api.submit(1,created.id,p.preparationId,source.sign(p.unsignedTransaction).tx_blob);
  expect(payment.state).toBe("validated_success");
  const purchases=[randomUUID(),randomUUID()],payload=(purchaseId:string)=>({schemaVersion:1,reference:payment.reference,transactionHash:payment.transactionHash,purchaseId});
  const results=await Promise.allSettled(purchases.map(id=>api.claim(1,payment.id,application,payload(id))));
  expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
  const index=results.findIndex(result=>result.status==="fulfilled"),successful=results[index];if(successful.status!=="fulfilled")throw new Error("No claim");
  expect(await api.claim(1,payment.id,application,payload(purchases[index]))).toEqual(successful.value);
  expect((await pg`SELECT count(*)::int AS n FROM xrpl_receipt_claims`)[0].n).toBe(1);
});

it("does not apply two validated payments to the same application purchase",async()=>{
  const api=service(),settle=async()=>{const created=await api.create(1,request(),randomUUID(),application),prepared=await api.prepare(1,created.id),p=prepared.preparation!;return api.submit(1,created.id,p.preparationId,source.sign(p.unsignedTransaction).tx_blob);};
  const a=await settle(),b=await settle(),purchaseId=randomUUID();expect(a.state).toBe("validated_success");expect(b.state).toBe("validated_success");
  const results=await Promise.allSettled([a,b].map(payment=>api.claim(1,payment.id,application,{schemaVersion:1,reference:payment.reference,transactionHash:payment.transactionHash,purchaseId})));
  expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
  expect((await pg`SELECT count(*)::int AS n FROM xrpl_receipt_claims`)[0].n).toBe(1);
});
