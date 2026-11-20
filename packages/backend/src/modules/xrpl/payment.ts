import { createHash, randomUUID } from "node:crypto";
import { decode, encode, deriveAddress, hashes, verifySignature, type Payment, type Transaction } from "xrpl";
import { classicAddress, destinationTag, drops } from "./validation";
import type { AccountSnapshot, FeeSnapshot, TransactionObservation } from "./read-adapter";
import type { XrplNetwork } from "./config";

/** `detail` carries public ledger amounts (drops) for plain messages; never secrets. */
export class PaymentError extends Error {
  constructor(public readonly code: string, public readonly status = 422, public readonly retryable = false, public readonly detail?: Readonly<Record<string, string>>) { super(code); this.name = "PaymentError"; }
}
export interface IntentInput {
  schemaVersion: 1; walletId: string; chain: "xrpl"; network: XrplNetwork;
  destination: string; destinationTag?: number; amountDrops: string; maxFeeDrops: string; reference: string;
}
export interface Preparation {
  preparationId: string; transactionDigest: string; unsignedBlob: string; unsignedTransaction: Payment;
  feeDrops: string; totalDrops: string; sequence: number; lastLedgerSequence: number;
  validatedLedgerIndex: number; validatedLedgerHash: string; preparedAt: string;
}
export interface Receipt {
  schemaVersion: 1; intentId: string; chain: "xrpl"; network: XrplNetwork; transactionHash: string;
  ledgerIndex: number; ledgerHash: string; validated: true; result: "tesSUCCESS";
  source: string; destination: string; destinationTag?: number; currency: "XRP";
  deliveredAmountDrops: string; feeDrops: string; reference: string; verifiedAt: string;
}
export const MAX_FEE_DROPS = 1000n;
/** Rows are only ever read through a network filter, so a row's own network is the pipeline's. Anything else is an integrity problem. */
export const rowNetwork = (row: { network: string }): XrplNetwork => {
  if (row.network !== "testnet" && row.network !== "mainnet") throw new PaymentError("INTEGRITY_MISMATCH", 503);
  return row.network;
};
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new PaymentError("INVALID_UUID", 400);
  return value.toLowerCase();
}
export function strictObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PaymentError("INVALID_SCHEMA", 400);
  const object = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => ![...required, ...optional].includes(key))) throw new PaymentError("INVALID_SCHEMA", 400);
  return object;
}
/** `network` is the one network the caller's pipeline runs on; an intent for any other network is refused. */
export function parseIntent(value: unknown, network: XrplNetwork = "testnet"): IntentInput {
  const body = strictObject(value, ["schemaVersion", "walletId", "chain", "network", "destination", "amountDrops", "maxFeeDrops", "reference"], ["destinationTag"]);
  if (body.schemaVersion !== 1 || body.chain !== "xrpl" || body.network !== network) throw new PaymentError("NETWORK_NOT_ALLOWED", 400);
  if (typeof body.walletId !== "string" || !/^[1-9]\d{0,14}$/.test(body.walletId)) throw new PaymentError("INVALID_WALLET", 400);
  try {
    const amount = drops(body.amountDrops, true), ceiling = drops(body.maxFeeDrops, true);
    if (ceiling > MAX_FEE_DROPS) throw new PaymentError("FEE_LIMIT_EXCEEDED");
    const tag = destinationTag(body.destinationTag);
    return { schemaVersion: 1, walletId: body.walletId, chain: "xrpl", network, destination: classicAddress(body.destination),
      ...(tag === undefined ? {} : { destinationTag: tag }), amountDrops: amount.toString(), maxFeeDrops: ceiling.toString(), reference: uuid(body.reference) };
  } catch (cause) { if (cause instanceof PaymentError) throw cause; throw new PaymentError("INVALID_PAYMENT_INPUT", 400); }
}
export const requestDigest = (input: IntentInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export const transactionDigest = (blob: string, network: XrplNetwork = "testnet") => createHash("sha256").update(`xrpl:${network}:payment-v1:${blob}`).digest("hex").toUpperCase();
export const referenceMemo = (reference: string) => [{ Memo: { MemoType: Buffer.from("amma-reference", "utf8").toString("hex").toUpperCase(), MemoData: Buffer.from(reference, "utf8").toString("hex").toUpperCase() } }];

export function assertSource(source: AccountSnapshot) {
  if (!source.funded || source.sequence === null) throw new PaymentError("SOURCE_NOT_FUNDED");
  if (source.masterDisabled || source.hasRegularKey || source.hasSignerList) throw new PaymentError("UNSUPPORTED_SIGNING_CONFIGURATION");
}
export function buildPreparation(input: IntentInput, source: AccountSnapshot, destination: AccountSnapshot, fee: FeeSnapshot, network: XrplNetwork = "testnet"): Preparation {
  if (input.network !== network) throw new PaymentError("NETWORK_NOT_ALLOWED", 400);
  assertSource(source);
  if (source.address === input.destination) throw new PaymentError("SELF_PAYMENT_NOT_ALLOWED");
  if (destination.address !== input.destination) throw new PaymentError("INVALID_ACCOUNT_OBSERVATION", 503, true);
  if (destination.requiresDestinationTag && input.destinationTag === undefined) throw new PaymentError("TAG_REQUIRED");
  if (destination.depositAuth || destination.disallowIncomingXrp) throw new PaymentError("UNSUPPORTED_DESTINATION");
  const feeDrops = drops(fee.feeDrops, true);
  if (feeDrops > BigInt(input.maxFeeDrops) || feeDrops > MAX_FEE_DROPS) throw new PaymentError("FEE_LIMIT_EXCEEDED");
  const amount = BigInt(input.amountDrops);
  // The source must keep its reserve (base + owner reserve per owned object) after the amount and fee.
  if (amount + feeDrops > BigInt(source.spendableDrops)) throw new PaymentError("INSUFFICIENT_SPENDABLE_BALANCE", 422, false, { reserveDrops: source.reserveDrops, spendableDrops: source.spendableDrops, feeDrops: feeDrops.toString(), ...(source.baseReserveDrops === undefined ? {} : { baseReserveDrops: source.baseReserveDrops }), ownerCount: String(source.ownerCount) });
  // An unactivated destination needs at least the base reserve (tecNO_DST_INSUF_XRP otherwise).
  if (!destination.funded && amount < BigInt(destination.reserveDrops)) throw new PaymentError("DESTINATION_RESERVE_REQUIRED", 422, false, { reserveDrops: destination.reserveDrops });
  const ledgers = [source.validatedLedgerIndex, destination.validatedLedgerIndex, fee.validatedLedgerIndex];
  if (Math.max(...ledgers) - Math.min(...ledgers) > 4 || [source, destination, fee].some(x => x.chain !== "xrpl" || x.network !== network || Date.now() - Date.parse(x.observedAt) > 30000 || Date.parse(x.observedAt) > Date.now() + 5000 || !Number.isFinite(Date.parse(x.observedAt)))) throw new PaymentError("STALE_PREPARATION", 503, true);
  const lastLedgerSequence = Math.max(...ledgers) + 20;
  if (lastLedgerSequence > 0xffffffff) throw new PaymentError("INVALID_ACCOUNT_OBSERVATION", 503);
  const transaction: Payment = { TransactionType: "Payment", Account: source.address, Destination: input.destination, Amount: input.amountDrops,
    ...(input.destinationTag === undefined ? {} : { DestinationTag: input.destinationTag }), Flags: 0x80000000,
    Fee: feeDrops.toString(), Sequence: source.sequence!, LastLedgerSequence: lastLedgerSequence, Memos: referenceMemo(input.reference) };
  const unsignedBlob = encode(transaction);
  return { preparationId: randomUUID(), unsignedTransaction: transaction, unsignedBlob, transactionDigest: transactionDigest(unsignedBlob, network),
    feeDrops: feeDrops.toString(), totalDrops: (amount + feeDrops).toString(), sequence: source.sequence!, lastLedgerSequence,
    validatedLedgerIndex: source.validatedLedgerIndex, validatedLedgerHash: source.validatedLedgerHash, preparedAt: new Date().toISOString() };
}

const transactionFields = ["TransactionType", "Account", "Destination", "Amount", "DestinationTag", "Fee", "Flags", "Sequence", "LastLedgerSequence", "Memos"];
export function validateSigned(blob: unknown, preparation: Preparation, input: IntentInput, source: string) {
  try {
    if (typeof blob !== "string" || blob.length < 100 || blob.length > 4096 || blob.length % 2 || !/^[A-Fa-f0-9]+$/.test(blob)) throw new Error();
    const normalized = blob.toUpperCase(), tx = decode(normalized);
    strictObject(tx, ["TransactionType", "Account", "Destination", "Amount", "Fee", "Flags", "Sequence", "LastLedgerSequence", "Memos", "SigningPubKey", "TxnSignature"], ["DestinationTag"]);
    if (encode(tx as unknown as Transaction) !== normalized || typeof tx.SigningPubKey !== "string" || deriveAddress(tx.SigningPubKey) !== source || !verifySignature(normalized)) throw new Error();
    const unsigned: Record<string, unknown> = {};
    for (const key of transactionFields) if (Object.hasOwn(tx, key)) unsigned[key] = tx[key];
    if (tx.Account !== source || tx.Destination !== input.destination || tx.Amount !== input.amountDrops || tx.DestinationTag !== input.destinationTag || tx.Flags !== 0x80000000 || tx.Fee !== preparation.feeDrops || tx.Sequence !== preparation.sequence || tx.LastLedgerSequence !== preparation.lastLedgerSequence || JSON.stringify(tx.Memos) !== JSON.stringify(referenceMemo(input.reference))) throw new Error();
    if (encode(unsigned as unknown as Transaction) !== preparation.unsignedBlob || transactionDigest(preparation.unsignedBlob, input.network) !== preparation.transactionDigest) throw new Error();
    return { blob: normalized, hash: hashes.hashSignedTx(normalized) };
  } catch { throw new PaymentError("SIGNED_TRANSACTION_MISMATCH", 422); }
}

export function observedSignedBlob(transaction: Record<string,unknown>): string {
  const normalized={...transaction};
  if(Object.hasOwn(normalized,"DeliverMax")){if(Object.hasOwn(normalized,"Amount"))throw new PaymentError("INTEGRITY_MISMATCH",503);normalized.Amount=normalized.DeliverMax;delete normalized.DeliverMax;}
  for(const field of ["date","hash","ledger_index","ledger_hash","inLedger","ctid"])delete normalized[field];
  return encode(normalized as unknown as Transaction);
}

export function verifySettlement(intentId: string, input: IntentInput, source: string, preparation: Preparation, hash: string, observation: TransactionObservation): { state: "validated_success" | "validated_failure"; receipt: Receipt | null; resultCode: string } | null {
  if (observation.status !== "validated") return null;
  try {
    if (observation.chain !== "xrpl" || observation.network !== input.network || observation.transactionHash !== hash || observation.ledgerIndex > preparation.lastLedgerSequence || observation.ledgerIndex < preparation.validatedLedgerIndex) throw new Error();
    const signed = validateSigned(observedSignedBlob(observation.transaction), preparation, input, source);
    if (signed.hash !== hash || observation.metadata.TransactionResult !== observation.resultCode) throw new Error();
    if (observation.resultCode !== "tesSUCCESS") {
      if (!/^tec[A-Z0-9_]+$/.test(observation.resultCode)) throw new Error();
      return { state: "validated_failure", receipt: null, resultCode: observation.resultCode };
    }
    if (drops(observation.metadata.delivered_amount, true).toString() !== input.amountDrops) throw new Error();
    return { state: "validated_success", resultCode: "tesSUCCESS", receipt: { schemaVersion: 1, intentId, chain: "xrpl", network: input.network, transactionHash: hash,
      ledgerIndex: observation.ledgerIndex, ledgerHash: observation.ledgerHash, validated: true, result: "tesSUCCESS", source, destination: input.destination,
      ...(input.destinationTag === undefined ? {} : { destinationTag: input.destinationTag }), currency: "XRP", deliveredAmountDrops: input.amountDrops,
      feeDrops: preparation.feeDrops, reference: input.reference, verifiedAt: new Date().toISOString() } };
  } catch { throw new PaymentError("INTEGRITY_MISMATCH", 503); }
}
