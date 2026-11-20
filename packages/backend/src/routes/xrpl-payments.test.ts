import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { Wallet, decode, type Payment } from "xrpl";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { legacyDatabase, migrate } from "../db/migrations/chain-storage.test-support";
import { applyPaymentStorage } from "../db/migrations/xrpl-payments";
import { applyReconciliationStorage } from "../db/migrations/xrpl-reconciliation";
import { applyIntegrationStorage } from "../db/migrations/xrpl-integration";
import type {AttemptInspection,ReconciliationEvidence} from "../modules/xrpl/reconciliation-adapter";
import type { AccountSnapshot, TransactionObservation } from "../modules/xrpl/read-adapter";
import type { IntentInput, Preparation } from "../modules/xrpl/payment";

const state = vi.hoisted(() => ({ db: undefined as any, enabled: true }));
vi.mock("../db", async () => ({ get db() { return state.db; }, schema: await import("../db/schema") }));
vi.mock("../config", () => ({ config: { JWT_SECRET: "local-only-xrp-payment-route-secret", XRPL_INTEGRATION_ENABLED: true, XRPL: { enabled: true }, get XRPL_PAYMENTS_ENABLED() { return state.enabled; } } }));
import { xrplPaymentRoutes } from "./xrpl-payments";

const source = Wallet.generate(), destination = Wallet.generate();
const headers = (owner = 1, type = "user") => ({ authorization: "Bearer " + jwt.sign({ userId: owner, type }, "local-only-xrp-payment-route-secret") });
const ledger = () => ({ chain: "xrpl" as const, network: "testnet" as const, endpoint: "wss://testnet.xrpl-labs.com/", validatedLedgerIndex: 1234, validatedLedgerHash: "A".repeat(64), observedAt: new Date().toISOString() });
const account = (address: string): AccountSnapshot => ({ ...ledger(), address, funded: true, balanceDrops: "20000000", reserveDrops: "1000000", spendableDrops: "19000000", sequence: 12, ownerCount: 0, requiresDestinationTag: false });
let app: FastifyInstance, pg: PGlite;
let delivered = "1000000", resultCode = "tesSUCCESS", lookupMode: "pending" | "validated" | "unavailable" | "not_found";
let seenBlob: string;
const network = {
  getAccount: vi.fn(async (address: string) => account(address)), getFee: vi.fn(async () => ({ ...ledger(), feeDrops: "12", currentLedgerIndex: 1235 })),
  getHealth: vi.fn(async () => ({ ...ledger(), status: "healthy" as const })),
  submitSigned: vi.fn(async (blob: string) => {
    // This callback runs only after a different transaction can observe commit.
    const rows = await pg.query<{ state: string; signed_blob: string; transaction_hash: string }>("SELECT state,signed_blob,transaction_hash FROM xrpl_payments WHERE signed_blob=$1",[blob]);
    expect(rows.rows[0]).toMatchObject({ state: "signed", signed_blob: blob });
    expect(rows.rows[0].transaction_hash).toMatch(/^[A-F0-9]{64}$/); seenBlob = blob;
    return { provisionalResult: "tesSUCCESS" };
  }),
  lookupTransaction: vi.fn(async (hash: string): Promise<TransactionObservation> => {
    if (lookupMode === "unavailable") throw new Error("raw RPC details must not escape");
    if (lookupMode !== "validated") return { ...ledger(), status: lookupMode, transactionHash: hash, validated: false, authoritative: false };
    return { ...ledger(), status: "validated", transactionHash: hash, validated: true, ledgerIndex: 1235, ledgerHash: "B".repeat(64), resultCode,
      transaction: decode(seenBlob), metadata: { TransactionResult: resultCode, delivered_amount: delivered } };
  }),
  inspectAttempt:vi.fn(async(input:AttemptInspection):Promise<ReconciliationEvidence>=>{
    const base={...ledger(),minLedger:input.minLedger,maxLedger:input.lastLedgerSequence,anchorHash:input.anchorHash};
    if(seenBlob&&input.hash&&lookupMode==="validated")return {...base,status:"validated",code:"VALIDATED_TRANSACTION",transaction:await network.lookupTransaction(input.hash)};
    if(lookupMode==="unavailable")throw new Error("network unavailable");
    return {...base,status:"open",code:"AWAITING_LEDGER_BOUND"};
  }),
};
const base = "/api/v1/xrpl/payment-intents";
function request(overrides = {}): IntentInput { return { schemaVersion: 1, walletId: "1", chain: "xrpl", network: "testnet", destination: destination.classicAddress, destinationTag: 0, amountDrops: "1000000", maxFeeDrops: "100", reference: randomUUID(), ...overrides }; }
async function create(body = request(), key = randomUUID(), owner = 1) {
  return app.inject({ method: "POST", url: base, headers: { ...headers(owner), "idempotency-key": key }, payload: body });
}
async function prepare() {
  const row = (await create()).json();
  const response = await app.inject({ method: "POST", url: `${base}/${row.id}/prepare`, headers: headers(), payload: {} });
  expect(response.statusCode).toBe(200);
  return response.json() as IntentInput & { id: string; preparation: Preparation };
}
async function submit(payment: Awaited<ReturnType<typeof prepare>>, blob = source.sign(payment.preparation.unsignedTransaction).tx_blob) {
  return app.inject({ method: "POST", url: `${base}/${payment.id}/submit`, headers: headers(), payload: { preparationId: payment.preparation.preparationId, blob } });
}
beforeAll(async () => {
  pg = await legacyDatabase(); await migrate(pg);
  await pg.transaction(tx => applyPaymentStorage({ execute: async sql => { await tx.exec(sql); }, rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows }));
  await pg.transaction(tx => applyReconciliationStorage({ execute: async sql => { await tx.exec(sql); }, rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows }));
  await pg.transaction(tx => applyIntegrationStorage({ execute: async sql => { await tx.exec(sql); }, rows: async <T extends Record<string, unknown>>(sql: string) => (await tx.query<T>(sql)).rows }));
  state.db = drizzle(pg);
  app = Fastify(); await app.register(xrplPaymentRoutes, { network,submissionGate:()=>{} }); await app.ready();
},30000);
beforeEach(async () => {
  state.enabled = true; delivered = "1000000"; resultCode = "tesSUCCESS"; lookupMode = "pending"; seenBlob = "";
  vi.clearAllMocks();
  network.getAccount.mockImplementation(async address => account(address));
  network.getFee.mockImplementation(async () => ({ ...ledger(), feeDrops: "12", currentLedgerIndex: 1235 }));
  await pg.exec(`TRUNCATE xrpl_receipt_claims,xrpl_payment_events,xrpl_payments,user_wallets RESTART IDENTITY;
    INSERT INTO user_wallets(id,user_id,name,public_key,chain,network,is_active) VALUES
    (1,1,'XRP','${source.classicAddress}','xrpl','testnet',true), (2,2,'Same source','${source.classicAddress}','xrpl','testnet',true),
    (3,1,'Stellar','G-stellar','stellar','testnet',true), (4,1,'Wrong network','${source.classicAddress}','xrpl','mainnet',true);`);
});
afterAll(async () => { await app?.close(); await pg?.close(); });

describe("owner-approved XRP payment routes with JWT and persisted database", () => {
  it("requires the separate payment flag, personal JWT and no application key", async () => {
    state.enabled = false; expect((await create()).statusCode).toBe(503); state.enabled = true;
    for (const h of [{}, headers(1,"admin"), headers(1,""), { ...headers(), "x-api-key": "legacy" }]) {
      expect([401,403]).toContain((await app.inject({ method: "POST", url: base, headers: { ...h, "idempotency-key": randomUUID() }, payload: request() })).statusCode);
    }
    expect(network.submitSigned).not.toHaveBeenCalled();
  });
  it("persists one intent for same-key retries and rejects conflicting body/reference reuse", async () => {
    const body=request(), key=randomUUID(), a=await create(body,key), b=await create(body,key);
    expect(a.statusCode).toBe(200); expect(b.json().id).toBe(a.json().id);
    expect((await create({ ...body, amountDrops:"2" },key)).statusCode).toBe(409);
    expect((await create(body)).statusCode).toBe(409);
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_payments")).rows[0]).toEqual({ n:1 });
  });
  it("requires idempotency and rejects private/extra input before any storage", async () => {
    for (const payload of [{ ...request(), seed:"must-not-store" },{ ...request(), approved:true }]) {
      const response=await create(payload); expect(response.statusCode).toBe(400); expect(response.body).not.toContain("must-not-store");
    }
    expect((await app.inject({method:"POST",url:base,headers:headers(),payload:request()})).statusCode).toBe(400);
    expect((await pg.query("SELECT count(*)::int AS n FROM xrpl_payments")).rows[0]).toEqual({n:0});
  });
  it("denies foreign owner, Stellar and mainnet wallet IDs", async () => {
    for(const walletId of ["2","3","4"]) expect((await create(request({walletId}))).statusCode).toBe(404);
    const payment=await prepare();
    for(const [method,suffix] of [["GET",""],["POST","/prepare"],["GET","/receipt"],["POST","/rebroadcast"],["POST","/cancel"]] as const) {
      expect((await app.inject({method,url:`${base}/${payment.id}${suffix}`,headers:headers(2),...(method==="POST"?{payload:{}}:{})})).statusCode).toBe(404);
    }
  });
  it("reuses preparations and blocks another unsigned preparation by the same owner", async () => {
    const payment=await prepare();
    const again=await app.inject({method:"POST",url:`${base}/${payment.id}/prepare`,headers:headers(),payload:{}});
    expect(again.json().preparation).toEqual(payment.preparation);
    const other=(await create()).json();
    expect((await app.inject({method:"POST",url:`${base}/${other.id}/prepare`,headers:headers(),payload:{}})).statusCode).toBe(409);
    expect(network.getFee).toHaveBeenCalledTimes(1);
  });
  it("cannot freeze another user's source using only public address metadata",async()=>{
    const shadow=(await create(request({walletId:"2"}),randomUUID(),2)).json();
    const shadowPrepared=await app.inject({method:"POST",url:`${base}/${shadow.id}/prepare`,headers:headers(2),payload:{}});
    expect(shadowPrepared.statusCode).toBe(200);
    const payment=await prepare();expect((await submit(payment)).statusCode).toBe(202);
    // Even when two sessions really do share the source key, only one signed
    // attempt can acquire its global reservation.
    const preparation=shadowPrepared.json().preparation;
    const conflict=await app.inject({method:"POST",url:`${base}/${shadow.id}/submit`,headers:headers(2),payload:{preparationId:preparation.preparationId,blob:source.sign(preparation.unsignedTransaction).tx_blob}});
    expect(conflict.statusCode).toBe(409);expect(network.submitSigned).toHaveBeenCalledTimes(1);
  });
  it("never broadcasts a transaction with changed approved details", async () => {
    const payment=await prepare();
    const signed=source.sign({...payment.preparation.unsignedTransaction,Amount:"2000000"} as Payment);
    expect((await submit(payment,signed.tx_blob)).statusCode).toBe(422);
    expect(network.submitSigned).not.toHaveBeenCalled();
    expect((await pg.query("SELECT state,signed_blob FROM xrpl_payments")).rows[0]).toEqual({state:"prepared",signed_blob:null});
  });
  it("commits the exact signed blob before broadcast and treats tesSUCCESS as provisional", async () => {
    const payment=await prepare(), response=await submit(payment);
    expect(response.statusCode).toBe(202); expect(response.json()).toMatchObject({state:"submitted",receipt:null,resultCode:null});
    expect(response.json()).not.toHaveProperty("signedBlob"); expect(response.json()).not.toHaveProperty("signed_blob");
    expect((await app.inject({method:"GET",url:`${base}/${payment.id}/receipt`,headers:headers()})).statusCode).toBe(409);
    const events=(await pg.query("SELECT to_state FROM xrpl_payment_events ORDER BY id")).rows;
    expect(events.map(row=>(row as any).to_state)).toEqual(["awaiting_approval","prepared","signed","signed","submitted"]);
  });
  it("survives submission timeout and retries only the saved blob", async () => {
    const payment=await prepare();
    network.submitSigned.mockRejectedValueOnce(new Error("unknown delivery"));
    const response=await submit(payment); expect(response.statusCode).toBe(202); expect(response.json()).toMatchObject({state:"signed",receipt:null});
    const saved=(await pg.query<{signed_blob:string}>("SELECT signed_blob FROM xrpl_payments")).rows[0].signed_blob;
    await pg.exec("UPDATE xrpl_payments SET last_broadcast_at=now()-interval '16 seconds'");
    const retry=await app.inject({method:"POST",url:`${base}/${payment.id}/rebroadcast`,headers:headers(),payload:{}});
    expect(retry.json().state).toBe("submitted"); expect(network.submitSigned.mock.calls[1][0]).toBe(saved);
  });
  it("does not release a prepared reservation on cancellation or not-found", async () => {
    const payment=await prepare(); expect((await app.inject({method:"POST",url:`${base}/${payment.id}/cancel`,headers:headers(),payload:{}})).statusCode).toBe(409);
    lookupMode="not_found"; await submit(payment);
    const status=await app.inject({method:"GET",url:`${base}/${payment.id}`,headers:headers()}); expect(status.json()).toMatchObject({state:"submitted",receipt:null});
  });
  it("cancels an unprepared intent without calling XRPL", async () => {
    const payment=(await create()).json();
    expect((await app.inject({method:"POST",url:`${base}/${payment.id}/cancel`,headers:headers(),payload:{}})).json().state).toBe("cancelled");
    expect(network.getAccount).not.toHaveBeenCalled(); expect(network.submitSigned).not.toHaveBeenCalled();
  });
  it("records exact validated success and returns an owner-only receipt", async () => {
    const payment=await prepare(); lookupMode="validated";
    const response=await submit(payment); expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({state:"validated_success",receipt:{validated:true,result:"tesSUCCESS",destinationTag:0,deliveredAmountDrops:"1000000",reference:payment.reference}});
    const receipt=await app.inject({method:"GET",url:`${base}/${payment.id}/receipt`,headers:headers()}); expect(receipt.statusCode).toBe(200);
    const before=network.submitSigned.mock.calls.length; await submit(payment); expect(network.submitSigned.mock.calls.length).toBe(before);
  });
  it("quarantines an integrity incident and cannot erase it through status or retry", async () => {
    const payment=await prepare(); lookupMode="validated"; delivered="999999";
    const mismatch=await submit(payment); expect(mismatch.json()).toMatchObject({state:"submitted",lastObservation:"INTEGRITY_MISMATCH",receipt:null});
    delivered="1000000";
    const status=await app.inject({method:"GET",url:`${base}/${payment.id}`,headers:headers()}); expect(status.json()).toMatchObject({state:"submitted",lastObservation:"INTEGRITY_MISMATCH",receipt:null});
    expect((await app.inject({method:"POST",url:`${base}/${payment.id}/rebroadcast`,headers:headers(),payload:{}})).statusCode).toBe(409);
    expect((await app.inject({method:"GET",url:`${base}/${payment.id}/receipt`,headers:headers()})).statusCode).toBe(409);
  });
  it("records validated tec failure without issuing a payment receipt",async()=>{
    const payment=await prepare();lookupMode="validated";resultCode="tecNO_DST";
    const failure=await submit(payment);expect(failure.json()).toMatchObject({state:"validated_failure",resultCode:"tecNO_DST",receipt:null});
    expect((await app.inject({method:"GET",url:`${base}/${payment.id}/receipt`,headers:headers()})).statusCode).toBe(409);
  });
});
