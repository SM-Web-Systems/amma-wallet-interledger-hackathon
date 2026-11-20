/** Independent consumer example. No Amma service/adapter imports or signing. */
import { Client, deriveAddress, encode, hashes, verifySignature, type Transaction } from "xrpl";

export interface ExpectedPurchase {
  intentId:string; source:string; destination:string; destinationTag?:number;
  amountDrops:string; maxFeeDrops:string; reference:string; purchaseId:string;
}
export type RpcRead=(request:Record<string,unknown>)=>Promise<Record<string,unknown>>;
const object=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("UNVERIFIED_PAYMENT");return value as Record<string,unknown>;
};
const positive=(value:unknown):value is string=>typeof value==="string"&&/^[1-9]\d{0,17}$/.test(value)&&BigInt(value)<=100000000000000000n;
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[A-F0-9]{64}$/.test(value);
const uint=(value:unknown):value is number=>typeof value==="number"&&Number.isInteger(value)&&value>0&&value<=0xffffffff;

/** Expected values must come from the consumer's stored purchase, never receipt JSON. */
export async function verifyReceipt(expected:ExpectedPurchase,value:unknown,read:RpcRead):Promise<{transactionHash:string;ledgerIndex:number}> {
  const receipt=object(value);
  if(!positive(expected.amountDrops)||!positive(expected.maxFeeDrops)||BigInt(expected.maxFeeDrops)>1000n||
    receipt.schemaVersion!==1||receipt.intentId!==expected.intentId||receipt.chain!=="xrpl"||receipt.network!=="testnet"||receipt.currency!=="XRP"||receipt.validated!==true||receipt.result!=="tesSUCCESS"||
    receipt.source!==expected.source||receipt.destination!==expected.destination||receipt.destinationTag!==expected.destinationTag||receipt.deliveredAmountDrops!==expected.amountDrops||receipt.reference!==expected.reference||
    !hash(receipt.transactionHash)||!hash(receipt.ledgerHash)||!uint(receipt.ledgerIndex)||!positive(receipt.feeDrops)||BigInt(receipt.feeDrops)>BigInt(expected.maxFeeDrops))throw new Error("UNVERIFIED_PAYMENT");
  const info=object((await read({command:"server_info"})).info);
  if(info.network_id!==1)throw new Error("WRONG_NETWORK");
  const result=await read({command:"tx",transaction:receipt.transactionHash,binary:false});
  if(result.validated!==true||result.hash!==receipt.transactionHash||result.ledger_index!==receipt.ledgerIndex)throw new Error("UNVERIFIED_PAYMENT");
  const tx={...object(result.tx_json)},meta=object(result.meta);
  if(Object.hasOwn(tx,"DeliverMax")){if(Object.hasOwn(tx,"Amount"))throw new Error("UNVERIFIED_PAYMENT");tx.Amount=tx.DeliverMax;delete tx.DeliverMax;}
  // API envelope fields are not part of the canonical signed transaction.
  for(const key of ["date","hash","ledger_index","ledger_hash","inLedger","ctid"])delete tx[key];
  const fields=["TransactionType","Account","Destination","DestinationTag","Amount","Fee","Flags","Sequence","LastLedgerSequence","Memos","SigningPubKey","TxnSignature"];
  const memos=tx.Memos;
  if(!Array.isArray(memos)||memos.length!==1)throw new Error("UNVERIFIED_PAYMENT");
  const wrapper=object(memos[0]),memo=object(wrapper.Memo);
  // RPC JSON may reorder object keys and change hex case. Compare memo bytes,
  // then verify the canonical encoded transaction hash and signature below.
  if(Object.keys(wrapper).join()!=="Memo"||Object.keys(memo).sort().join()!=="MemoData,MemoType"||
    typeof memo.MemoType!=="string"||typeof memo.MemoData!=="string"||
    memo.MemoType.toUpperCase()!==Buffer.from("amma-reference").toString("hex").toUpperCase()||
    memo.MemoData.toUpperCase()!==Buffer.from(expected.reference).toString("hex").toUpperCase())throw new Error("UNVERIFIED_PAYMENT");
  if(Object.keys(tx).some(key=>!fields.includes(key))||tx.TransactionType!=="Payment"||tx.Account!==expected.source||tx.Destination!==expected.destination||tx.DestinationTag!==expected.destinationTag||tx.Amount!==expected.amountDrops||
    tx.Fee!==receipt.feeDrops||tx.Flags!==0x80000000||!uint(tx.Sequence)||!uint(tx.LastLedgerSequence)||receipt.ledgerIndex>tx.LastLedgerSequence||meta.TransactionResult!=="tesSUCCESS"||meta.delivered_amount!==expected.amountDrops)throw new Error("UNVERIFIED_PAYMENT");
  if(typeof tx.SigningPubKey!=="string"||deriveAddress(tx.SigningPubKey)!==expected.source)throw new Error("UNVERIFIED_PAYMENT");
  const blob=encode(tx as unknown as Transaction);
  if(hashes.hashSignedTx(blob)!==receipt.transactionHash||!verifySignature(blob))throw new Error("UNVERIFIED_PAYMENT");
  const ledger=await read({command:"ledger",ledger_index:receipt.ledgerIndex,transactions:false,expand:false});
  if(ledger.validated!==true||ledger.ledger_index!==receipt.ledgerIndex||ledger.ledger_hash!==receipt.ledgerHash)throw new Error("UNVERIFIED_PAYMENT");
  return {transactionHash:receipt.transactionHash,ledgerIndex:receipt.ledgerIndex};
}

export async function independentlyVerifyTestnet(expected:ExpectedPurchase,receipt:unknown) {
  // Trust this independently configured endpoint, never a URL in an API response.
  const client=new Client("wss://testnet.xrpl-labs.com/",{connectionTimeout:10000,timeout:10000});
  client.on("error",()=>{}); // Request/connect promises carry failure; no raw RPC logging.
  try {await client.connect();return await verifyReceipt(expected,receipt,async request=>(await client.request(request as any)).result as unknown as Record<string,unknown>);}
  finally {await client.disconnect();}
}

export class AmmaTestnetConsumer {
  constructor(private readonly apiOrigin:string,private readonly userJwt:string,private readonly applicationKey:string) {
    const url=new URL(apiOrigin);
    if(url.username||url.password||url.search||url.hash||url.pathname!=="/"||!(url.protocol==="https:"||(url.protocol==="http:"&&["127.0.0.1","localhost"].includes(url.hostname))))throw new Error("TRUSTED_API_ORIGIN_REQUIRED");
  }
  private async request(path:string,method="GET",payload?:unknown,idempotencyKey?:string):Promise<Record<string,unknown>> {
    const response=await fetch(new URL(path,this.apiOrigin),{method,redirect:"error",signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${this.userJwt}`,"X-API-Key":this.applicationKey,...(payload?{"Content-Type":"application/json"}:{}),...(idempotencyKey?{"Idempotency-Key":idempotencyKey}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
    if(!response.ok)throw new Error(`AMMA_HTTP_${response.status}`);return object(await response.json());
  }
  create(input:Record<string,unknown>,idempotencyKey:string){return this.request("/api/v1/xrpl/payment-intents","POST",input,idempotencyKey);}
  status(intentId:string){return this.request(`/api/v1/xrpl/payment-intents/${encodeURIComponent(intentId)}`);}
  async verifyAndClaim(expected:ExpectedPurchase,verify=independentlyVerifyTestnet) {
    const receipt=await this.request(`/api/v1/xrpl/payment-intents/${encodeURIComponent(expected.intentId)}/receipt`);
    await verify(expected,receipt); // No fulfilment or claim on a failed/pending verification.
    return this.request(`/api/v1/xrpl/payment-intents/${encodeURIComponent(expected.intentId)}/claims`,"POST",{schemaVersion:1,reference:expected.reference,transactionHash:receipt.transactionHash,purchaseId:expected.purchaseId});
    // Consumer must persist the claim/hash/purchase with UNIQUE constraints in
    // its own DB before fulfilment. This example does not implement fulfilment.
  }
}
