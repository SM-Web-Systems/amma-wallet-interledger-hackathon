import {beforeAll,afterAll,afterEach,describe,it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import jwt from "jsonwebtoken";
import {drizzle} from "drizzle-orm/pglite";
import type {PGlite} from "@electric-sql/pglite";
import {legacyDatabase,migrate} from "../../db/migrations/chain-storage.test-support";
import {applyPaymentStorage} from "../../db/migrations/xrpl-payments";
import {applyReconciliationStorage} from "../../db/migrations/xrpl-reconciliation";
import {applyIntegrationStorage} from "../../db/migrations/xrpl-integration";
const state=vi.hoisted(()=>({db:undefined as any}));
vi.mock("../../db",async()=>({get db(){return state.db;},schema:await import("../../db/schema")}));
vi.mock("../../config",()=>({config:{JWT_SECRET:"m8-local-user-session-secret",ADMIN_JWT_SECRET:"m8-local-admin-session-secret",XRPL:{enabled:true},XRPL_PAYMENTS_ENABLED:true}}));
import {pendingSummary,startXrplMonitor,initialSnapshot,collectOperations,type OperationsSnapshot} from "./operations";
import {readMonitorConfig} from "./config";
import {XrplReadAdapter} from "./read-adapter";
import {xrplOperationsRoutes} from "../../routes/xrpl-operations";
import {PaymentError} from "./payment";
import {xrplPaymentRoutes} from "../../routes/xrpl-payments";
let pg:PGlite;
const healthy=():OperationsSnapshot=>({...initialSnapshot(true),status:"healthy",checkedAt:new Date().toISOString(),pending:{prepared:0,signed:0,submitted:0,overdue:0,quarantined:0,retryBudgetExhausted:0,activeLeases:0,oldestAgeSeconds:0},endpoints:[{id:0,status:"healthy",validatedLedgerIndex:1234}]});
beforeAll(async()=>{
  pg=await legacyDatabase();await migrate(pg);
  for(const apply of [applyPaymentStorage,applyReconciliationStorage,applyIntegrationStorage])await pg.transaction(tx=>apply({execute:async statement=>{await tx.exec(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>(await tx.query<T>(statement)).rows}));
  state.db=drizzle(pg);
  const ddl=readFileSync(resolve("drizzle/0003_petite_emma_frost.sql"),"utf8"),start=ddl.indexOf('CREATE TABLE "internal_admins" (');await pg.exec(ddl.slice(start,ddl.indexOf("\n);",start)+3));
  await pg.exec("INSERT INTO internal_admins(id,email,name,role,password_hash,is_active) VALUES(1,'admin@example.invalid','Ops','platform_admin','unused',true),(2,'support@example.invalid','Support','support_agent','unused',true)");
},30000);
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
afterAll(async()=>{await pg?.close();});
describe("bounded aggregate operations monitoring",()=>{
  it("is disabled by default and rejects invalid intervals/thresholds",()=>{
    expect(readMonitorConfig({}).enabled).toBe(false);expect(()=>readMonitorConfig({XRPL_MONITORING_ENABLED:"true"})).toThrow();
    expect(()=>readMonitorConfig({XRPL_MONITORING_INTERVAL_MS:"1"})).toThrow();expect(()=>readMonitorConfig({XRPL_PENDING_ALERT_SECONDS:"0"})).toThrow();
  });
  it("counts only nonterminal Testnet attempts and does not reset age on repeated observation",async()=>{
    await pg.exec(`INSERT INTO user_wallets(id,user_id,name,public_key,chain,network) VALUES(1,1,'Public XRP','public-fixture','xrpl','testnet');
      INSERT INTO xrpl_payments(id,user_id,wallet_id,idempotency_key,request_digest,reference,source,request,state,preparation_id,preparation,created_at,updated_at)
      VALUES('00000000-0000-4000-8000-000000000001',1,1,'00000000-0000-4000-8000-000000000002',repeat('a',64),'00000000-0000-4000-8000-000000000003','public-fixture','{}','prepared','00000000-0000-4000-8000-000000000004','{}',now()-interval '1 hour',now());`);
    const summary=await pendingSummary(300);expect(summary).toMatchObject({prepared:1,signed:0,submitted:0,overdue:1,quarantined:0,activeLeases:0});expect(summary.oldestAgeSeconds).toBeGreaterThanOrEqual(3600);
    expect(JSON.stringify(summary)).not.toContain("public-fixture");expect(Object.keys(summary)).toHaveLength(8);
  });
  describe("on XRPL mainnet (XRPL_MAINNET_CUSTODY=on)",()=>{
    const MAIN={STELLAR_NETWORK:"public",MAINNET_CUSTODY:"on",XRPL_NETWORK:"mainnet",XRPL_MAINNET_CUSTODY:"on",XRPL_ENABLED:"true",XRPL_MAINNET_WS:"wss://a.example/,wss://b.example/"};
    it("is allowed and keyed on the mainnet network",()=>{
      expect(readMonitorConfig({...MAIN,XRPL_MONITORING_ENABLED:"true"})).toMatchObject({enabled:true,network:"mainnet"});
      expect(readMonitorConfig({}).network).toBe("testnet");
      expect(initialSnapshot(true,"mainnet").network).toBe("mainnet");
    });
    it("counts only mainnet attempts (testnet rows are not mixed in)",async()=>{
      // The testnet row from the test above stays; no mainnet rows exist.
      expect(await pendingSummary(300,"mainnet")).toMatchObject({prepared:0,signed:0,submitted:0});
      expect((await pendingSummary(300,"testnet")).prepared).toBeGreaterThanOrEqual(0);
    });
    it("probes each mainnet endpoint on its own, through XRPL_MAINNET_WS",async()=>{
      const seen:string[]=[];
      vi.spyOn(XrplReadAdapter.prototype,"getHealth").mockImplementation(async function(this:XrplReadAdapter){seen.push(this.xrplNetwork);return {status:"healthy",chain:"xrpl",network:"mainnet",endpoint:"wss://a.example/",validatedLedgerIndex:9,validatedLedgerHash:"A".repeat(64),observedAt:new Date().toISOString()};});
      const snapshot=await collectOperations({enabled:true,intervalMs:60000,pendingSeconds:300,network:"mainnet"},MAIN);
      expect(snapshot.network).toBe("mainnet");expect(seen).toEqual(["mainnet","mainnet"]);
      expect(snapshot.endpoints).toEqual([{id:0,status:"healthy",validatedLedgerIndex:9},{id:1,status:"healthy",validatedLedgerIndex:9}]);
    });
  });
  it("probes each configured endpoint independently and reports failure without raw errors",async()=>{
    vi.spyOn(XrplReadAdapter.prototype,"getHealth").mockRejectedValueOnce(new Error("sensitive rpc details")).mockResolvedValueOnce({status:"healthy",chain:"xrpl",network:"testnet",endpoint:"wss://testnet.xrpl-labs.com/",validatedLedgerIndex:1234,validatedLedgerHash:"A".repeat(64),observedAt:new Date().toISOString()});
    const snapshot=await collectOperations({enabled:true,intervalMs:60000,pendingSeconds:300},{XRPL_ENABLED:"true"});
    expect(snapshot.status).toBe("degraded");expect(snapshot.endpoints).toEqual([{id:0,status:"unavailable"},{id:1,status:"healthy",validatedLedgerIndex:1234}]);expect(JSON.stringify(snapshot)).not.toContain("sensitive");
  });
  it("does not query while disabled; never overlaps; alerts on change and recovers",async()=>{
    vi.useFakeTimers();const unused=vi.fn();await startXrplMonitor({enabled:false,intervalMs:15000,pendingSeconds:300},vi.fn(),unused).stop();expect(unused).not.toHaveBeenCalled();
    let finish!:(snapshot:OperationsSnapshot)=>void;const collect=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(healthy()),log=vi.fn();
    const monitor=startXrplMonitor({enabled:true,intervalMs:15000,pendingSeconds:300},log,collect);await vi.advanceTimersByTimeAsync(60000);expect(collect).toHaveBeenCalledTimes(1);
    finish({...healthy(),status:"unavailable",pending:null});await vi.advanceTimersByTimeAsync(0);expect(log.mock.calls[0][0].event).toBe("xrpl_operations_alert");
    await vi.advanceTimersByTimeAsync(15000);expect(log.mock.calls[1][0].event).toBe("xrpl_operations_recovered");
    await vi.advanceTimersByTimeAsync(15000);expect(log).toHaveBeenCalledTimes(2);await monitor.stop();await vi.advanceTimersByTimeAsync(30000);expect(collect).toHaveBeenCalledTimes(3);
  });
  it("suppresses unchanged alerts until reminder interval and sanitizes collector failures",async()=>{
    vi.useFakeTimers();const log=vi.fn(),collect=vi.fn().mockRejectedValue(new Error("private DB URL"));const monitor=startXrplMonitor({enabled:true,intervalMs:15000,pendingSeconds:300},log,collect);
    await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(45000);expect(log).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(900000);expect(log).toHaveBeenCalledTimes(2);expect(JSON.stringify(log.mock.calls)).not.toContain("private");await monitor.stop();
  });
  it("does not re-alert when only the size of an ongoing problem changes",async()=>{
    vi.useFakeTimers();const log=vi.fn();let overdue=0;
    const collect=vi.fn().mockImplementation(async()=>{overdue+=1;const base=healthy();return {...base,status:"degraded",pending:{...base.pending!,overdue}};});
    const monitor=startXrplMonitor({enabled:true,intervalMs:15000,pendingSeconds:300},log,collect);
    await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(60000);
    expect(collect.mock.calls.length).toBeGreaterThan(3);expect(log).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(900000);expect(log).toHaveBeenCalledTimes(2);await monitor.stop();
  });
});
describe("actual protected operational routes and signing rate limits",()=>{
  const admin=(id="1",role="platform_admin",secret="m8-local-admin-session-secret",type="admin")=>({authorization:`Bearer ${jwt.sign({sub:id,role,type},secret)}`});
  it("requires an active privileged admin and returns only cached aggregate state",async()=>{
    const app=Fastify();await app.register(xrplOperationsRoutes,{snapshot:healthy});
    for(const headers of [{},admin("1","platform_admin","m8-local-user-session-secret","user"),admin("1bad"),admin("2","support_agent"),{...admin(),"x-api-key":"not-an-admin-key"}])expect([401,403]).toContain((await app.inject({url:"/api/v1/internal/xrpl/operations",headers})).statusCode);
    const response=await app.inject({url:"/api/v1/internal/xrpl/operations",headers:admin()});expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");expect(response.json().pending).toHaveProperty("overdue");
    await pg.exec("UPDATE internal_admins SET is_active=false WHERE id=1");expect((await app.inject({url:"/api/v1/internal/xrpl/operations",headers:admin()})).statusCode).toBe(401);await pg.exec("UPDATE internal_admins SET is_active=true WHERE id=1");await app.close();
  });
  it("keeps saved status readable while admission/signing is paused, then reports explicit resume",async()=>{
    let paused=true;const app=Fastify();await app.register(xrplPaymentRoutes,{submissionGate:()=>{if(paused)throw new PaymentError("XRPL_SUBMISSION_PAUSED",503,true);}});
    const headers={authorization:`Bearer ${jwt.sign({type:"user",userId:1},"m8-local-user-session-secret")}`};
    const availability=()=>app.inject({url:"/api/v1/xrpl/payment-availability",headers});
    expect((await availability()).json()).toMatchObject({available:false,code:"XRPL_SUBMISSION_PAUSED"});
    expect((await app.inject({method:"POST",url:"/api/v1/xrpl/payment-intents/00000000-0000-4000-8000-000000000001/prepare",headers,payload:{}})).json().error.code).toBe("XRPL_SUBMISSION_PAUSED");
    expect((await pg.query<{state:string}>("SELECT state FROM xrpl_payments")).rows[0].state).toBe("prepared");
    paused=false;expect((await availability()).json()).toMatchObject({available:true,code:"AVAILABLE"});await app.close();
  });
  it("reports the live submission pause state, not the cached one",async()=>{
    const app=Fastify();await app.register(xrplOperationsRoutes,{snapshot:()=>({...healthy(),submission:{available:true,code:"AVAILABLE"}}),submission:()=>({available:false,code:"XRPL_SUBMISSION_PAUSED"})});
    const response=await app.inject({url:"/api/v1/internal/xrpl/operations",headers:admin()});
    expect(response.json().submission).toEqual({available:false,code:"XRPL_SUBMISSION_PAUSED"});await app.close();
  });
  it("does not advertise stale cached health as ready",async()=>{
    const app=Fastify();await app.register(xrplOperationsRoutes,{snapshot:()=>({...healthy(),checkedAt:new Date(Date.now()-601000).toISOString()})});expect((await app.inject({url:"/api/v1/internal/xrpl/operations",headers:admin()})).statusCode).toBe(503);await app.close();
  });
  it("does not let arbitrary API-key or access-token rotation bypass owner signing limits",async()=>{
    const app=Fastify();await app.register(rateLimit,{max:1000,keyGenerator:request=>String(request.headers["x-api-key"]??request.ip)});await app.register(xrplPaymentRoutes,{submissionGate:()=>{}});
    const statuses=[];for(let i=0;i<6;i++){statuses.push((await app.inject({method:"POST",url:"/api/v1/xrpl/payment-intents/00000000-0000-4000-8000-000000000099/prepare",headers:{authorization:`Bearer ${jwt.sign({type:"user",userId:1,jti:String(i)},"m8-local-user-session-secret")}`},payload:{}})).statusCode);}
    expect(statuses.slice(0,5)).toEqual([404,404,404,404,404]);expect(statuses[5]).toBe(429);
    for(let i=0;i<3;i++)expect((await app.inject({method:"POST",url:"/api/v1/xrpl/payment-intents/00000000-0000-4000-8000-000000000099/prepare",headers:{authorization:`Bearer ${jwt.sign({type:"user",userId:1},"m8-local-user-session-secret")}`,"x-api-key":`rotated-${i}`},payload:{}})).statusCode).toBe(403);
    await app.close();
  });
});
