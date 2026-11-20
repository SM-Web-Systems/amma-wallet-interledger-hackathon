import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from "vitest";
import Fastify,{type FastifyInstance} from "fastify";
import jwt from "jsonwebtoken";
import Ajv2020 from "ajv/dist/2020";
import {xrplIntegrationOpenApi} from "../modules/xrpl/integration-openapi";
import { Wallet,decode } from "xrpl";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase,migrate } from "../db/migrations/chain-storage.test-support";
import { applyPaymentStorage } from "../db/migrations/xrpl-payments";
import { applyReconciliationStorage } from "../db/migrations/xrpl-reconciliation";
import { applyIntegrationStorage } from "../db/migrations/xrpl-integration";
import { hashApiKey,_clearRateLimitWindowsForTest } from "../middleware/tenant-api-key";
import { AmmaTestnetConsumer,verifyReceipt,type ExpectedPurchase } from "../examples/xrpl-consumer";
import type { AttemptInspection } from "../modules/xrpl/reconciliation-adapter";

const state=vi.hoisted(()=>({db:undefined as any,integration:true}));
vi.mock("../db",async()=>({get db(){return state.db;},schema:await import("../db/schema")}));
vi.mock("../config",()=>({config:{JWT_SECRET:"local-only-integration-access-secret",XRPL:{enabled:true},XRPL_PAYMENTS_ENABLED:true,get XRPL_INTEGRATION_ENABLED(){return state.integration;},API_KEYS:["legacy-env-key-with-no-xrp-scope"]}}));
import { xrplPaymentRoutes } from "./xrpl-payments";

const source=Wallet.generate(),destination=Wallet.generate();
const key1="application-one-private-key-test",key2="application-two-private-key-test",rotated="application-one-rotated-key-test";
const base="/api/v1/xrpl/payment-intents";
let pg:PGlite,app:FastifyInstance,observed="",validated=false,delivered="1000000",resultCode="tesSUCCESS";
const ledger=()=>({chain:"xrpl" as const,network:"testnet" as const,endpoint:"wss://testnet.xrpl-labs.com/",validatedLedgerIndex:1234,validatedLedgerHash:"A".repeat(64),observedAt:new Date().toISOString()});
const network={
  getAccount:vi.fn(async(address:string)=>({...ledger(),address,funded:true,balanceDrops:"20000000",reserveDrops:"1000000",spendableDrops:"19000000",sequence:12,ownerCount:0,requiresDestinationTag:false})),
  getFee:vi.fn(async()=>({...ledger(),feeDrops:"12",currentLedgerIndex:1235})),getHealth:vi.fn(),
  submitSigned:vi.fn(async(blob:string)=>{observed=blob;return {provisionalResult:"tesSUCCESS"};}),
  lookupTransaction:vi.fn(),
  inspectAttempt:vi.fn(async(input:AttemptInspection)=>{
    const evidence={...ledger(),minLedger:input.minLedger,maxLedger:input.lastLedgerSequence,anchorHash:input.anchorHash};
    return validated&&observed&&input.hash?{...evidence,status:"validated" as const,code:"VALIDATED_TRANSACTION",transaction:{...ledger(),status:"validated" as const,transactionHash:input.hash,validated:true as const,ledgerIndex:1235,ledgerHash:"B".repeat(64),resultCode,transaction:decode(observed),metadata:{TransactionResult:resultCode,delivered_amount:delivered}}}:{...evidence,status:"open" as const,code:"AWAITING_LEDGER_BOUND"};
  }),
};
const token=(owner=1,type="user",secret="local-only-integration-access-secret",expiresIn=900)=>jwt.sign({userId:owner,type},secret,{expiresIn});
const headers=(key:string|null|undefined=key1,owner=1)=>({authorization:`Bearer ${token(owner)}`,...(key?{"x-api-key":key}:{})});
const input=(overrides={})=>({schemaVersion:1,walletId:"1",chain:"xrpl",network:"testnet",destination:destination.classicAddress,destinationTag:0,amountDrops:"1000000",maxFeeDrops:"100",reference:randomUUID(),...overrides});
const create=(body=input(),idempotencyKey=randomUUID(),key=key1,owner=1)=>app.inject({method:"POST",url:base,headers:{...headers(key,owner),"idempotency-key":idempotencyKey},payload:body});
const get=(id:string,suffix="",key=key1,owner=1)=>app.inject({method:"GET",url:`${base}/${id}${suffix}`,headers:headers(key,owner)});
const claim=(payment:any,purchaseId=randomUUID(),key=key1,overrides={})=>app.inject({method:"POST",url:`${base}/${payment.id}/claims`,headers:headers(key),payload:{schemaVersion:1,reference:payment.reference,transactionHash:payment.transactionHash,purchaseId,...overrides}});
async function settle(body=input(),key=key1){
  const created=(await create(body,randomUUID(),key)).json();
  const prepared=await app.inject({method:"POST",url:`${base}/${created.id}/prepare`,headers:headers(null),payload:{}});
  expect(prepared.statusCode).toBe(200);const preparation=prepared.json().preparation;
  const submit=await app.inject({method:"POST",url:`${base}/${created.id}/submit`,headers:headers(null),payload:{preparationId:preparation.preparationId,blob:source.sign(preparation.unsignedTransaction).tx_blob}});
  expect(submit.statusCode).toBe(202);validated=true;
  const final=await get(created.id,"",key);expect(final.json().state).toBe("validated_success");return final.json();
}
beforeAll(async()=>{
  pg=await legacyDatabase();await migrate(pg);
  for(const apply of [applyPaymentStorage,applyReconciliationStorage,applyIntegrationStorage])await pg.transaction(tx=>apply({execute:async statement=>{await tx.exec(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>(await tx.query<T>(statement)).rows}));
  state.db=drizzle(pg);app=Fastify();await app.register(xrplPaymentRoutes,{network,submissionGate:()=>{}});await app.ready();
},30000);
beforeEach(async()=>{
  validated=false;observed="";delivered="1000000";resultCode="tesSUCCESS";state.integration=true;state.db=drizzle(pg);vi.clearAllMocks();_clearRateLimitWindowsForTest();
  await pg.exec("TRUNCATE xrpl_receipt_claims,xrpl_payment_events,xrpl_payments,user_wallets,tenant_users,tenant_api_keys,tenants RESTART IDENTITY");
  await pg.query("INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active) VALUES (1,1,'Owner XRP',$1,'xrpl','testnet',true),(2,2,'Other XRP',$1,'xrpl','testnet',true)",[source.classicAddress]);
  await pg.exec("INSERT INTO tenants(id,slug,name) VALUES (1,'one','Application One'),(2,'two','Application Two');INSERT INTO tenant_users(tenant_id,user_id) VALUES (1,1),(1,2),(2,1)");
  for(const [id,tenant,key] of [[1,1,key1],[2,2,key2],[3,1,rotated]] as const)await pg.query("INSERT INTO tenant_api_keys(id,tenant_id,name,key_hash,key_prefix,scopes,rate_limit_per_minute) VALUES ($1,$2,'Synthetic test key',$3,'test',$4,100)",[id,tenant,hashApiKey(key),["xrpl:payments:create","xrpl:payments:read","xrpl:receipts:claim"]]);
});
afterAll(async()=>{await app?.close();await pg?.close();});

describe("external XRP application API with actual JWT, routes and migrated database",()=>{
  it("publishes a credential-free versioned OpenAPI contract with AND authentication",async()=>{
    const response=await app.inject({method:"GET",url:"/api/v1/xrpl/openapi.json"});expect(response.statusCode).toBe(200);
    expect(response.json().security).toEqual([{UserSession:[],ApplicationKey:[]}]);expect(response.json().info.version).toBe("1.0.0");
    expect(response.json()).toEqual(JSON.parse(readFileSync(resolve("../../docs/xrpl/openapi.v1.json"),"utf8")));
    expect(response.body).not.toContain(key1);expect(response.json().paths[`${base}/{id}/claims`].post["x-required-application-scope"]).toBe("xrpl:receipts:claim");
  });
  it("validates real external responses against the published schemas",async()=>{
    const ajv=new Ajv2020({strict:false,validateFormats:false});ajv.addSchema({components:xrplIntegrationOpenApi.components},"integration");
    const matches=(name:string,value:unknown)=>{const validate=ajv.compile({$ref:`integration#/components/schemas/${name}`});expect(validate(value),JSON.stringify(validate.errors)).toBe(true);};
    const payment=await settle();matches("PaymentStatus",payment);matches("Receipt",(await get(payment.id,"/receipt")).json());matches("Claim",(await claim(payment)).json());
    matches("Error",(await get(randomUUID())).json());
  });
  it("creates only an approval request, exposes a safe path, and keeps preparation private to the owner UI",async()=>{
    const response=await create();expect(response.statusCode).toBe(200);const payment=response.json();
    expect(payment).toMatchObject({state:"awaiting_approval",application:{tenantId:"1",name:"Application One"},transactionHash:null});
    expect(payment.approvalPath).toBe(`/xrpl?walletId=1&intentId=${payment.id}`);expect(payment).not.toHaveProperty("preparation");expect(payment).not.toHaveProperty("receipt");
    expect(network.getFee).not.toHaveBeenCalled();expect(network.submitSigned).not.toHaveBeenCalled();
    expect((await get(payment.id)).headers["cache-control"]).toBe("no-store");
  });
  it("requires the separate integration flag",async()=>{
    state.integration=false;expect((await create()).json().error.code).toBe("XRPL_INTEGRATION_DISABLED");
    const personal=await app.inject({method:"POST",url:base,headers:{...headers(null),"idempotency-key":randomUUID()},payload:input()});expect(personal.statusCode).toBe(200);
  });
  it("requires a personal access JWT as well as an application key",async()=>{
    for(const authorization of [undefined,`Bearer ${token(1,"admin")}`,`Bearer ${token(1,"sso")}`,`Bearer ${token(1,"")}`,`Bearer ${token(1,"user","wrong-signing-secret-long")}`,`Bearer ${token(1,"user",undefined,-1)}`]){
      const response=await app.inject({method:"POST",url:base,headers:{"x-api-key":key1,"idempotency-key":randomUUID(),...(authorization?{authorization}:{})},payload:input()});expect(response.statusCode).toBe(401);
    }
  });
  it.each(["legacy-env-key-with-no-xrp-scope","unregistered-key-with-valid-length"])("rejects legacy or unknown key %s without a fallback",async key=>{expect((await create(input(),randomUUID(),key)).statusCode).toBe(403);});
  it("fails closed on an auth database outage, including a configured legacy key",async()=>{
    state.db={select(){throw new Error("sensitive database connection must not escape");}};
    const response=await create(input(),randomUUID(),"legacy-env-key-with-no-xrp-scope");expect(response.statusCode).toBe(503);expect(response.json().error.code).toBe("APPLICATION_AUTH_UNAVAILABLE");expect(response.body).not.toContain("sensitive");
  });
  it.each(["UPDATE tenant_api_keys SET is_active=false WHERE id=1","UPDATE tenant_api_keys SET expires_at=now()-interval '1 second' WHERE id=1","UPDATE tenants SET is_active=false WHERE id=1","UPDATE tenants SET suspended_at=now() WHERE id=1","DELETE FROM tenant_users WHERE tenant_id=1 AND user_id=1"])("rejects revoked/expired/suspended/unbound applications: %s",async statement=>{await pg.exec(statement);expect((await create()).statusCode).toBe(403);});
  it("requires exact scopes, rejects wildcards, and separates create/read/claim",async()=>{
    await pg.exec("UPDATE tenant_api_keys SET scopes=ARRAY['xrpl:*'] WHERE id=1");expect((await create()).statusCode).toBe(403);
    await pg.exec("UPDATE tenant_api_keys SET scopes=ARRAY['xrpl:payments:create'] WHERE id=1");const payment=(await create()).json();
    expect((await get(payment.id)).statusCode).toBe(403);expect((await claim({...payment,transactionHash:"A".repeat(64)})).statusCode).toBe(403);
    await pg.exec("UPDATE tenant_api_keys SET scopes=ARRAY['xrpl:payments:read'] WHERE id=1");expect((await create()).statusCode).toBe(403);expect((await get(payment.id)).statusCode).toBe(200);
  });
  it("enforces per-key limits without storing or returning the raw key",async()=>{
    await pg.exec("UPDATE tenant_api_keys SET rate_limit_per_minute=1 WHERE id=1");expect((await create()).statusCode).toBe(200);const response=await create();expect(response.statusCode).toBe(429);expect(response.body).not.toContain(key1);
  });
  it("scopes idempotency and references by user and tenant while preserving key rotation",async()=>{
    const body=input(),key=randomUUID(),a=(await create(body,key)).json();expect((await create(body,key,rotated)).json().id).toBe(a.id);
    expect((await create({...body,amountDrops:"2"},key)).statusCode).toBe(409);expect((await create(body)).statusCode).toBe(409);
    const b=(await create(body,key,key2)).json();expect(b.id).not.toBe(a.id);
    const personal=await app.inject({method:"POST",url:base,headers:{...headers(null),"idempotency-key":key},payload:body});expect(personal.statusCode).toBe(200);expect(personal.json().id).not.toBe(a.id);
  });
  it("denies other users, applications and personal-intent probing before any ledger work",async()=>{
    const a=(await create()).json();expect((await get(a.id,"",key2)).statusCode).toBe(404);expect((await get(a.id,"",key1,2)).statusCode).toBe(404);
    const personal=(await app.inject({method:"POST",url:base,headers:{...headers(null),"idempotency-key":randomUUID()},payload:input()})).json();
    expect((await get(personal.id)).statusCode).toBe(404);expect((await get(personal.id,"/receipt")).statusCode).toBe(404);
    expect((await create(input({walletId:"2"}))).statusCode).toBe(404);expect(network.inspectAttempt).not.toHaveBeenCalled();
  });
  it("never allows an API key to list private intents, prepare, sign, submit, retry or cancel",async()=>{
    const payment=(await create()).json();
    for(const suffix of ["prepare","submit","rebroadcast","cancel"]){expect((await app.inject({method:"POST",url:`${base}/${payment.id}/${suffix}`,headers:headers(),payload:{}})).statusCode).toBe(403);}
    expect((await app.inject({method:"GET",url:`${base}?walletId=1`,headers:headers()})).statusCode).toBe(403);expect(network.submitSigned).not.toHaveBeenCalled();
  });
  it("rejects body-selected application/owner, sensitive fields and approved=true",async()=>{
    for(const extra of [{applicationTenantId:2},{ownerId:2},{seed:"private-not-stored"},{approved:true},{callbackUrl:"https://evil.invalid"}])expect((await create(input(extra))).statusCode).toBe(400);
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_payments")).rows[0]).toEqual({n:0});
  });
  it("returns structured redacted errors for malformed or oversized JSON",async()=>{
    for(const payload of ['{"seed":',JSON.stringify({seed:"x".repeat(7000)})]){
      const response=await app.inject({method:"POST",url:base,headers:{...headers(),"content-type":"application/json"},payload});expect([400,413]).toContain(response.statusCode);expect(response.json().error.requestId).toBeTruthy();expect(response.body).not.toContain("seed");
    }
  });
  it("never claims an unsigned, pending, failed or mismatched settlement",async()=>{
    const payment=(await create()).json();expect((await claim({...payment,transactionHash:"A".repeat(64)})).statusCode).toBe(409);
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_receipt_claims")).rows[0]).toEqual({n:0});
  });
  it.each(["validated_failure","expired"])("never consumes a terminal %s attempt",async state=>{
    const payment=await settle();
    await pg.query("UPDATE xrpl_payments SET state=$1,receipt=null,result_code='tecPATH_DRY',reconciliation_evidence=$3::jsonb WHERE id=$2",[state,payment.id,JSON.stringify({status:"expired",code:"NON_INCLUSION_PROVEN"})]);
    const response=await claim(payment);expect(response.statusCode).toBe(409);expect(response.json().error.code).toBe("RECEIPT_UNAVAILABLE");
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_receipt_claims")).rows[0]).toEqual({n:0});
  });
  it("claims a validated exact payment once, with idempotent retry across rotating keys",async()=>{
    const payment=await settle(),purchaseId=randomUUID(),a=await claim(payment,purchaseId);expect(a.statusCode).toBe(200);
    const b=await claim(payment,purchaseId,rotated);expect(b.json()).toEqual(a.json());expect((await claim(payment)).json().error.code).toBe("RECEIPT_ALREADY_CLAIMED");
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_receipt_claims")).rows[0]).toEqual({n:1});
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_payment_events WHERE code='RECEIPT_CLAIMED'")).rows[0]).toEqual({n:1});
    expect(a.body).not.toContain(observed);expect(a.body).not.toContain(key1);
  });
  it("checks reference/hash, scope and app/owner before consuming a receipt",async()=>{
    const payment=await settle();
    for(const overrides of [{reference:randomUUID()},{transactionHash:"F".repeat(64)}])expect((await claim(payment,randomUUID(),key1,overrides)).json().error.code).toBe("CLAIM_PAYMENT_MISMATCH");
    expect((await claim(payment,randomUUID(),key2)).statusCode).toBe(404);
    expect((await app.inject({method:"POST",url:`${base}/${payment.id}/claims`,headers:headers(null),payload:{}})).statusCode).toBe(401);
    expect((await claim(payment)).statusCode).toBe(200);
  });
  it("atomically chooses one purchase from simultaneous claim attempts",async()=>{
    const payment=await settle();const responses=await Promise.all([claim(payment),claim(payment)]);expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_receipt_claims")).rows[0]).toEqual({n:1});
  });
  it("will not apply a second payment to an already consumed tenant purchase",async()=>{
    const a=await settle(),purchaseId=randomUUID();expect((await claim(a,purchaseId)).statusCode).toBe(200);
    validated=false;observed="";const b=await settle(input({amountDrops:"1000000"}));expect((await claim(b,purchaseId)).json().error.code).toBe("RECEIPT_ALREADY_CLAIMED");
  });
  it("rejects forged stored receipt data rather than consuming it",async()=>{
    const payment=await settle();await pg.query("UPDATE xrpl_payments SET receipt=jsonb_set(receipt,'{deliveredAmountDrops}','\"1\"') WHERE id=$1",[payment.id]);
    expect((await claim(payment)).json().error.code).toBe("PAYMENT_INTEGRITY_REVIEW_REQUIRED");
  });
  it("lets a separate HTTP consumer create an approval request, independently verify and claim",async()=>{
    await app.listen({host:"127.0.0.1",port:0});const address=app.server.address();if(!address||typeof address==="string")throw new Error("No HTTP listener");
    const consumer=new AmmaTestnetConsumer(`http://127.0.0.1:${address.port}`,token(),key1),body=input(),created=await consumer.create(body,randomUUID());
    expect(created.state).toBe("awaiting_approval");expect(network.submitSigned).not.toHaveBeenCalled();
    const preparation=(await app.inject({method:"POST",url:`${base}/${created.id}/prepare`,headers:headers(null),payload:{}})).json().preparation;
    await app.inject({method:"POST",url:`${base}/${created.id}/submit`,headers:headers(null),payload:{preparationId:preparation.preparationId,blob:source.sign(preparation.unsignedTransaction).tx_blob}});validated=true;await consumer.status(String(created.id));
    const expected:ExpectedPurchase={intentId:String(created.id),source:source.classicAddress,destination:destination.classicAddress,destinationTag:0,amountDrops:body.amountDrops,maxFeeDrops:body.maxFeeDrops,reference:body.reference,purchaseId:randomUUID()};
    const verify=async(e:ExpectedPurchase,receipt:unknown)=>verifyReceipt(e,receipt,async request=>request.command==="server_info"?{info:{network_id:1}}:request.command==="tx"?{validated:true,hash:(receipt as any).transactionHash,ledger_index:1235,tx_json:decode(observed),meta:{TransactionResult:"tesSUCCESS",delivered_amount:body.amountDrops}}:{validated:true,ledger_index:1235,ledger_hash:"B".repeat(64)});
    const result=await consumer.verifyAndClaim(expected,verify);expect(result.purchaseId).toBe(expected.purchaseId);
    const calls=network.submitSigned.mock.calls.length;await consumer.verifyAndClaim(expected,verify);expect(network.submitSigned.mock.calls.length).toBe(calls);
  });
});
