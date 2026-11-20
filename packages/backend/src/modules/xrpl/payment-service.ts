import {assertSubmissionAllowed,type SubmissionGate} from "./submission-control";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db, schema } from "../../db";
import { XrplReconciliationAdapter } from "./reconciliation-adapter";
import { SEND_GATE_CODES, XrplReconciler, type RecoveryNetwork } from "./reconciler";
import type { XrplNetwork } from "./config";
import { rowNetwork, PaymentError, strictObject, assertSource, buildPreparation, parseIntent, requestDigest, uuid, validateSigned, type Preparation, type Receipt } from "./payment";

type Row = typeof schema.xrplPayments.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PaymentNetwork = RecoveryNetwork;
// One tenant is one application security boundary. Rotation keys share it.
export interface PaymentApplication { tenantId: number; keyId: number; name: string }
const table = schema.xrplPayments;
const applicationScope = (application?: PaymentApplication) => application ? eq(table.applicationTenantId, application.tenantId) : isNull(table.applicationTenantId);
const owned = (owner: number, net: XrplNetwork) => and(eq(table.userId, owner), eq(table.chain, "xrpl"), eq(table.network, net));
const input = (row: Row) => parseIntent(row.request, rowNetwork(row));
const prepared = (row: Row) => {
  if (!row.preparation || !row.preparationId) throw new PaymentError("NOT_PREPARED", 409);
  return row.preparation as Preparation;
};
function dto(row: Row) {
  return { ...input(row), id: row.id, ownerId: String(row.userId), source: row.source, state: row.state,
    preparation: row.preparation as Preparation | null, transactionHash: row.transactionHash,
    resultCode: ["validated_success", "validated_failure"].includes(row.state) ? row.resultCode : null,
    lastObservation: row.lastObservation, receipt: row.receipt as Receipt | null,
    application: row.applicationTenantId === null ? null : { tenantId: String(row.applicationTenantId), name: row.applicationName },
    approvalPath: `/xrpl?walletId=${row.walletId}&intentId=${row.id}`,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
async function event(tx: Tx, row: Row, to: string, code: string) {
  await tx.insert(schema.xrplPaymentEvents).values({ intentId: row.id, fromState: row.state, toState: to, code });
}
async function lockIntent(tx: Tx, owner: number, id: string, net: XrplNetwork): Promise<Row> {
  const [row] = await tx.select().from(table).where(and(owned(owner, net), eq(table.id, id))).for("update");
  if (!row) throw new PaymentError("PAYMENT_NOT_FOUND", 404);
  return row;
}
async function ownedWallet(tx: Tx, owner: number, walletId: string, net: XrplNetwork) {
  const [wallet] = await tx.select({ address: schema.userWallets.publicKey }).from(schema.userWallets).where(and(eq(schema.userWallets.userId, owner), eq(schema.userWallets.id, Number(walletId)), eq(schema.userWallets.chain, "xrpl"), eq(schema.userWallets.network, net)));
  if (!wallet) throw new PaymentError("WALLET_NOT_FOUND", 404);
  return wallet;
}

export class XrplPaymentService {
  private readonly reconciler: XrplReconciler;
  /** The one XRPL network this service's rows, wallets and observations belong to. */
  readonly net: XrplNetwork;
  /** `net` defaults to the adapter's own network (testnet for adapters that do not say); a mismatch is refused. */
  constructor(private readonly network: PaymentNetwork = new XrplReconciliationAdapter(), private readonly submissionGate:SubmissionGate=assertSubmissionAllowed, net?: XrplNetwork) {
    const own = (network as { xrplNetwork?: XrplNetwork }).xrplNetwork;
    if (net && own && net !== own) throw new Error(`The XRP payment service is set for ${net} but its ledger connection is ${own}`);
    this.net = net ?? own ?? "testnet";
    this.reconciler=new XrplReconciler(network, this.net);
  }
  private async row(owner: number, id: string): Promise<Row> {
    const [row] = await db.select().from(table).where(and(owned(owner, this.net), eq(table.id, uuid(id))));
    if (!row) throw new PaymentError("PAYMENT_NOT_FOUND", 404);
    return row;
  }
  async list(owner: number, walletId: string) {
    if (!/^[1-9]\d{0,14}$/.test(walletId)) throw new PaymentError("INVALID_WALLET", 400);
    return db.transaction(async tx => {
      await ownedWallet(tx, owner, walletId, this.net);
      const rows = await tx.select().from(table).where(and(owned(owner, this.net), eq(table.walletId, Number(walletId))))
        .orderBy(sql`CASE WHEN ${table.state} IN ('prepared','signed','submitted') THEN 0 ELSE 1 END`, desc(table.createdAt)).limit(20);
      return rows.map(dto);
    });
  }
  async assertApplication(owner: number, id: string, application: PaymentApplication) {
    const row = await this.row(owner, id);
    if (row.applicationTenantId !== application.tenantId) throw new PaymentError("PAYMENT_NOT_FOUND",404);
  }
  async create(owner: number, body: unknown, key: unknown, application?: PaymentApplication) {
    const request = parseIntent(body, this.net), idempotencyKey = uuid(key), digest = requestDigest(request);
    return db.transaction(async tx => {
      // Serializes idempotency/reference decisions for this authenticated owner.
      await tx.execute(sql`SELECT id FROM users WHERE id=${owner} FOR NO KEY UPDATE`);
      const wallet = await ownedWallet(tx, owner, request.walletId, this.net);
      if (wallet.address === request.destination) throw new PaymentError("SELF_PAYMENT_NOT_ALLOWED");
      const [existing] = await tx.select().from(table).where(and(owned(owner, this.net), applicationScope(application), eq(table.idempotencyKey, idempotencyKey)));
      if (existing) {
        if (existing.requestDigest !== digest) throw new PaymentError("IDEMPOTENCY_CONFLICT", 409);
        return dto(existing);
      }
      const [reference] = await tx.select({ id: table.id }).from(table).where(and(owned(owner, this.net), applicationScope(application), eq(table.reference, request.reference)));
      if (reference) throw new PaymentError("REFERENCE_ALREADY_USED", 409);
      const [row] = await tx.insert(table).values({ id: randomUUID(), userId: owner, walletId: Number(request.walletId), chain: "xrpl", network: this.net, idempotencyKey, requestDigest: digest,
        reference: request.reference, source: wallet.address, request,
        applicationTenantId: application?.tenantId ?? null, applicationName: application?.name ?? null }).returning();
      await tx.insert(schema.xrplPaymentEvents).values({ intentId: row.id, fromState: null, toState: "awaiting_approval", code: "CREATED" });
      return dto(row);
    });
  }
  async prepare(owner: number, id: string) {
    this.submissionGate();
    try {
      return await db.transaction(async tx => {
        const row = await lockIntent(tx, owner, uuid(id), this.net);
        if (row.state === "prepared") return dto(row);
        if (row.state !== "awaiting_approval") throw new PaymentError("PAYMENT_UNRESOLVED", 409);
        const request = input(row), wallet = await ownedWallet(tx, owner, request.walletId, this.net);
        if (wallet.address !== row.source) throw new PaymentError("WALLET_CHANGED", 409);
        // Unsigned public metadata may only reserve this owner's preparation.
        // A different user knowing the address must not freeze the real owner.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`xrpl:${this.net}:${owner}:${row.source}`},0))`);
        const [active] = await tx.select({ id: table.id }).from(table).where(and(eq(table.source, row.source), eq(table.chain, "xrpl"), eq(table.network, this.net), or(and(eq(table.userId,owner),sql`${table.state} IN ('prepared','signed','submitted')`),sql`${table.state} IN ('signed','submitted')`))).limit(1);
        if (active) throw new PaymentError("PAYMENT_UNRESOLVED", 409);
        const [source, destination, fee] = await Promise.all([this.network.getAccount(row.source), this.network.getAccount(request.destination), this.network.getFee()]);
        if (source.address !== row.source) throw new PaymentError("INVALID_ACCOUNT_OBSERVATION", 503);
        const preparation = buildPreparation(request, source, destination, fee, this.net);
        const [updated] = await tx.update(table).set({ state: "prepared", preparationId: preparation.preparationId, preparation, updatedAt: new Date() }).where(eq(table.id, row.id)).returning();
        await event(tx, row, "prepared", "PREPARED");
        return dto(updated);
      });
    } catch (cause) {
      // Another process may win the unique source reservation after its read.
      const pg = cause as { code?: string; cause?: { code?: string } };
      if (pg?.code === "23505" || pg?.cause?.code === "23505") throw new PaymentError("PAYMENT_UNRESOLVED", 409);
      throw cause;
    }
  }
  async submit(owner: number, id: string, preparationId: string, blob: unknown) {
    this.submissionGate();
    await db.transaction(async tx => {
      const row = await lockIntent(tx, owner, uuid(id), this.net);
      if(["INTEGRITY_MISMATCH","LEDGER_RESET","SEQUENCE_CONSUMED","TRANSACTION_ALREADY_BOUND"].includes(row.lastObservation??""))throw new PaymentError("PAYMENT_REVIEW_REQUIRED",409);
      const preparation = prepared(row);
      if (uuid(preparationId) !== row.preparationId) throw new PaymentError("PREPARATION_MISMATCH", 409);
      const signed = validateSigned(blob, preparation, input(row), row.source);
      if (row.transactionHash) {
        if (row.transactionHash !== signed.hash || row.signedBlob !== signed.blob) throw new PaymentError("SIGNED_TRANSACTION_CONFLICT", 409);
        return; // Identical retries always refer to this one persisted attempt.
      }
      if (row.state !== "prepared") throw new PaymentError("PAYMENT_UNRESOLVED", 409);
      // A signature proving source-key control is required before acquiring a
      // global account reservation, including across different registered owners.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`xrpl:${this.net}:${row.source}`},0))`);
      const [active] = await tx.select({ id: table.id }).from(table).where(and(eq(table.source,row.source),eq(table.chain,"xrpl"),eq(table.network,this.net),sql`${table.state} IN ('signed','submitted')`)).limit(1);
      if (active) throw new PaymentError("PAYMENT_UNRESOLVED",409);
      await ownedWallet(tx, owner, String(row.walletId), this.net);
      const source = await this.network.getAccount(row.source);
      assertSource(source);
      if (source.sequence !== preparation.sequence || source.validatedLedgerIndex > preparation.lastLedgerSequence) throw new PaymentError("PAYMENT_UNRESOLVED", 409);
      if (BigInt(source.spendableDrops) < BigInt(preparation.totalDrops)) throw new PaymentError("INSUFFICIENT_SPENDABLE_BALANCE");
      // Fence out a worker inspecting the earlier unsigned preparation.
      await tx.update(table).set({ state: "signed", signedBlob: signed.blob, transactionHash: signed.hash, leaseToken:null,leaseExpiresAt:null,nextReconcileAt:new Date(),reconcileFailures:0,updatedAt: new Date() }).where(eq(table.id, row.id));
      await event(tx, row, "signed", "SIGNED_BLOB_PERSISTED");
    });
    // Commit above completes before any external broadcast is possible.
    try { return await this.rebroadcast(owner, id); }
    catch (cause) {
      // The signed payment is saved; recovery broadcasts it once submission resumes.
      if (cause instanceof PaymentError && (SEND_GATE_CODES.includes(cause.code) || cause.code === "RECOVERY_IN_PROGRESS")) return this.status(owner, id);
      throw cause;
    }
  }
  async rebroadcast(owner: number, id: string) {
    const row=await this.row(owner,id);
    if (row.lastObservation === "INTEGRITY_MISMATCH") throw new PaymentError("PAYMENT_INTEGRITY_REVIEW_REQUIRED", 409);
    if (["LEDGER_RESET","SEQUENCE_CONSUMED","TRANSACTION_ALREADY_BOUND"].includes(row.lastObservation??"")) throw new PaymentError("PAYMENT_REVIEW_REQUIRED",409);
    if (["expired","validated_success","validated_failure","cancelled"].includes(row.state))return dto(row);
    if (!row.signedBlob || !row.transactionHash) throw new PaymentError("NOT_SIGNED", 409);
    this.submissionGate();
    const {row:after,processed}=await this.reconciler.attempt(owner,id,true);
    // Recovery (a worker, or a lease left by a process that died) holds this
    // payment, so nothing was sent now. Say so instead of a silent 200.
    if(!processed&&["prepared","signed","submitted"].includes(after.state))throw new PaymentError("RECOVERY_IN_PROGRESS",409,true);
    return dto(after);
  }
  async status(owner: number, id: string) {
    return dto(await this.reconciler.reconcile(owner,id,false));
  }
  async reconcileBatch(limit=10,allowBroadcast=false,signal?:AbortSignal){return this.reconciler.runDue(limit,allowBroadcast,signal);}
  async receipt(owner: number, id: string) {
    const payment = await this.status(owner, id);
    if (payment.state !== "validated_success" || !payment.receipt) throw new PaymentError("RECEIPT_UNAVAILABLE", 409,
      !["validated_failure","expired","cancelled"].includes(payment.state)&&!["INTEGRITY_MISMATCH","LEDGER_RESET","SEQUENCE_CONSUMED","TRANSACTION_ALREADY_BOUND"].includes(payment.lastObservation??""));
    return payment.receipt;
  }
  async cancel(owner: number, id: string) {
    return db.transaction(async tx => {
      const row = await lockIntent(tx, owner, uuid(id), this.net);
      if (row.state === "cancelled") return dto(row);
      // Prepared material might have been signed outside this server. Its source
      // reservation cannot be released by an ordinary cancellation request.
      if (row.state !== "awaiting_approval") throw new PaymentError("PAYMENT_UNRESOLVED", 409);
      const [updated] = await tx.update(table).set({ state: "cancelled", updatedAt: new Date() }).where(eq(table.id, row.id)).returning();
      await event(tx, row, "cancelled", "CANCELLED_BEFORE_PREPARATION"); return dto(updated);
    });
  }
  async claim(owner: number, id: string, application: PaymentApplication, body: unknown) {
    const request = strictObject(body,["schemaVersion","reference","transactionHash","purchaseId"]);
    if(request.schemaVersion!==1 || typeof request.transactionHash!=="string" || !/^[A-F0-9]{64}$/.test(request.transactionHash))throw new PaymentError("INVALID_CLAIM",400);
    const reference=uuid(request.reference),purchaseId=uuid(request.purchaseId);
    await this.assertApplication(owner,id,application);
    await this.receipt(owner,id); // Reconcile outside the short claim transaction; never broadcasts.
    return db.transaction(async tx=>{
      const row=await lockIntent(tx,owner,uuid(id),this.net);
      if(row.applicationTenantId!==application.tenantId)throw new PaymentError("PAYMENT_NOT_FOUND",404);
      if(row.state!=="validated_success"||!row.receipt||!row.transactionHash)throw new PaymentError("RECEIPT_UNAVAILABLE",409);
      const receipt=row.receipt as Receipt,expected=input(row),preparation=prepared(row);
      if(receipt.schemaVersion!==1||receipt.intentId!==row.id||receipt.chain!=="xrpl"||receipt.network!==this.net||receipt.validated!==true||receipt.result!=="tesSUCCESS"||row.resultCode!=="tesSUCCESS"||receipt.transactionHash!==row.transactionHash||receipt.source!==row.source||receipt.destination!==expected.destination||receipt.destinationTag!==expected.destinationTag||receipt.deliveredAmountDrops!==expected.amountDrops||receipt.currency!=="XRP"||receipt.reference!==row.reference||receipt.feeDrops!==preparation.feeDrops)throw new PaymentError("PAYMENT_INTEGRITY_REVIEW_REQUIRED",409);
      if(reference!==row.reference||request.transactionHash!==row.transactionHash)throw new PaymentError("CLAIM_PAYMENT_MISMATCH",409);
      const claims=schema.xrplReceiptClaims;
      // Unique intent/hash/reference/purchase constraints decide the race, even
      // when two different payment rows target the same external purchase.
      const [inserted]=await tx.insert(claims).values({id:randomUUID(),intentId:row.id,applicationTenantId:application.tenantId,userId:owner,apiKeyId:application.keyId,transactionHash:row.transactionHash,reference,purchaseId}).onConflictDoNothing().returning();
      const [saved]=inserted?[inserted]:await tx.select().from(claims).where(eq(claims.intentId,row.id));
      if(!saved||saved.applicationTenantId!==application.tenantId||saved.userId!==owner||saved.purchaseId!==purchaseId||saved.reference!==reference||saved.transactionHash!==row.transactionHash)throw new PaymentError("RECEIPT_ALREADY_CLAIMED",409);
      if(inserted)await event(tx,row,row.state,"RECEIPT_CLAIMED");
      return {schemaVersion:1 as const,id:saved.id,intentId:saved.intentId,applicationTenantId:String(saved.applicationTenantId),chain:"xrpl" as const,network:this.net,transactionHash:saved.transactionHash,reference:saved.reference,purchaseId:saved.purchaseId,claimedAt:saved.claimedAt.toISOString()};
    });
  }
}
