import { decode, encode, type Payment, type Transaction } from "xrpl";

export interface PaymentInput {
  schemaVersion: 1; walletId: string; chain: "xrpl"; network: "testnet";
  destination: string; destinationTag?: number; amountDrops: string; maxFeeDrops: string; reference: string;
}
export interface PaymentPreparation {
  preparationId: string; transactionDigest: string; unsignedBlob: string; unsignedTransaction: Payment;
  feeDrops: string; totalDrops: string; sequence: number; lastLedgerSequence: number;
  validatedLedgerIndex: number; validatedLedgerHash: string; preparedAt: string;
}
export interface PaymentReceipt {
  schemaVersion: 1; intentId: string; chain: "xrpl"; network: "testnet"; transactionHash: string;
  ledgerIndex: number; ledgerHash: string; validated: true; result: "tesSUCCESS"; source: string; destination: string;
  destinationTag?: number; currency: "XRP"; deliveredAmountDrops: string; feeDrops: string; reference: string; verifiedAt: string;
}
export interface PaymentIntent extends PaymentInput {
  application?: {tenantId:string;name:string} | null; approvalPath?: string;
  id: string; ownerId: string; source: string; state: "awaiting_approval" | "prepared" | "signed" | "submitted" | "validated_success" | "validated_failure" | "expired" | "cancelled";
  preparation: PaymentPreparation | null; transactionHash: string | null; resultCode: string | null;
  lastObservation: string | null; receipt: PaymentReceipt | null; createdAt: string; updatedAt: string;
}
export function formatXrp(drops: string): string {
  const n = BigInt(drops); return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6,"0")}`;
}
export function parseXrp(value: string): string {
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(value)) throw new Error("Enter a positive XRP amount with at most six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const drops = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6,"0"));
  if (drops <= 0n || drops > 100_000_000_000_000_000n) throw new Error("The XRP amount is outside the supported range.");
  return drops.toString();
}
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (required.some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => ![...required,...optional].includes(key))) throw new Error("The prepared transaction contains unexpected fields. Do not sign it.");
}
const positive = (value: unknown) => typeof value === "string" && /^[1-9]\d{0,17}$/.test(value) && BigInt(value) <= 100_000_000_000_000_000n;
const uint = (value: unknown, min = 0) => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= 0xffffffff;
export function assertIntentContext(intent: PaymentIntent, walletId: string, source: string, ownerId: string) {
  if (intent.schemaVersion !== 1 || intent.chain !== "xrpl" || intent.network !== "testnet" || intent.walletId !== walletId || intent.source !== source || intent.ownerId !== ownerId) throw new Error("This payment does not match your selected Testnet wallet.");
}
export function sameRequest(intent: PaymentInput, request: PaymentInput): boolean {
  return ["schemaVersion","walletId","chain","network","destination","destinationTag","amountDrops","maxFeeDrops","reference"].every(key => intent[key as keyof PaymentInput] === request[key as keyof PaymentInput]);
}
/** Independent browser validation; this runs before decrypting and again before signing. */
export async function assertPreparedPayment(intent: PaymentIntent, preparation: PaymentPreparation, source: string): Promise<Payment> {
  if (intent.schemaVersion !== 1 || intent.chain !== "xrpl" || intent.network !== "testnet" || intent.source !== source || intent.state !== "prepared" || !positive(intent.amountDrops) || !positive(intent.maxFeeDrops) || BigInt(intent.maxFeeDrops) > 1000n || intent.destination === source || !/^[0-9a-f-]{36}$/.test(intent.reference)) throw new Error("Invalid XRP Testnet payment preview.");
  if (intent.destinationTag !== undefined && !uint(intent.destinationTag)) throw new Error("Invalid destination tag.");
  if (!positive(preparation.feeDrops) || BigInt(preparation.feeDrops) > BigInt(intent.maxFeeDrops) || preparation.totalDrops !== (BigInt(intent.amountDrops) + BigInt(preparation.feeDrops)).toString() || !uint(preparation.sequence,1) || !uint(preparation.validatedLedgerIndex,1) || !uint(preparation.lastLedgerSequence,1) || preparation.lastLedgerSequence <= preparation.validatedLedgerIndex || preparation.lastLedgerSequence > preparation.validatedLedgerIndex + 24) throw new Error("Invalid fee, sequence or ledger bound in payment preview.");
  if (!/^[A-F0-9]{100,4096}$/.test(preparation.unsignedBlob) || preparation.unsignedBlob.length % 2) throw new Error("Invalid prepared transaction encoding.");
  const decoded = decode(preparation.unsignedBlob);
  exactKeys(decoded,["TransactionType","Account","Destination","Amount","Flags","Fee","Sequence","LastLedgerSequence","Memos"],["DestinationTag"]);
  const hex = (text: string) => Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2,"0")).join("").toUpperCase();
  const expected: Payment = { TransactionType:"Payment", Account:source, Destination:intent.destination, Amount:intent.amountDrops,
    ...(intent.destinationTag === undefined ? {} : { DestinationTag:intent.destinationTag }), Flags:0x80000000,
    Fee:preparation.feeDrops, Sequence:preparation.sequence, LastLedgerSequence:preparation.lastLedgerSequence,
    Memos:[{Memo:{MemoType:hex("amma-reference"),MemoData:hex(intent.reference)}}] };
  if (encode(expected) !== preparation.unsignedBlob || encode(preparation.unsignedTransaction) !== preparation.unsignedBlob || encode(decoded as unknown as Transaction) !== preparation.unsignedBlob) throw new Error("Prepared transaction differs from the payment preview. Do not sign it.");
  // Encoding may ignore unknown object properties, so check the JSON separately.
  exactKeys(preparation.unsignedTransaction as unknown as Record<string,unknown>,["TransactionType","Account","Destination","Amount","Flags","Fee","Sequence","LastLedgerSequence","Memos"],["DestinationTag"]);
  const hash = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`xrpl:testnet:payment-v1:${preparation.unsignedBlob}`));
  const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,"0")).join("").toUpperCase();
  if (digest !== preparation.transactionDigest) throw new Error("Payment preview digest does not match.");
  return expected;
}
