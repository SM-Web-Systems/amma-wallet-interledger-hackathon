// @vitest-environment node
// Crypto/IndexedDB library test: jsdom's realm breaks Uint8Array identity checks in @noble and Stellar SDKs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { Wallet, ECDSA, encode, hashes, verifySignature } from "xrpl";
import { assertPreparedPayment, parseXrp, formatXrp, type PaymentIntent } from "./payment";
import { saveLocalWallet, signApprovedPayment } from "./vault";

const source=Wallet.generate(),destination=Wallet.generate();
const phrase="synthetic approved payment passphrase";
async function intent(address=source.classicAddress):Promise<PaymentIntent> {
  const reference=crypto.randomUUID(),hex=(v:string)=>Buffer.from(v).toString("hex").toUpperCase();
  const unsignedTransaction={TransactionType:"Payment" as const,Account:address,Destination:destination.classicAddress,Amount:"1000000",DestinationTag:0,Flags:0x80000000,Fee:"12",Sequence:12,LastLedgerSequence:1254,Memos:[{Memo:{MemoType:hex("amma-reference"),MemoData:hex(reference)}}]};
  const unsignedBlob=encode(unsignedTransaction);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`xrpl:testnet:payment-v1:${unsignedBlob}`));
  return {schemaVersion:1,id:crypto.randomUUID(),walletId:"1",ownerId:"1",source:address,chain:"xrpl",network:"testnet",destination:destination.classicAddress,destinationTag:0,amountDrops:"1000000",maxFeeDrops:"100",reference,state:"prepared",transactionHash:null,resultCode:null,lastObservation:null,receipt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),preparation:{preparationId:crypto.randomUUID(),unsignedTransaction,unsignedBlob,transactionDigest:Buffer.from(digest).toString("hex").toUpperCase(),feeDrops:"12",totalDrops:"1000012",sequence:12,lastLedgerSequence:1254,validatedLedgerIndex:1234,validatedLedgerHash:"A".repeat(64),preparedAt:new Date().toISOString()}};
}
beforeEach(()=>{vi.stubGlobal("crypto",webcrypto);vi.stubGlobal("indexedDB",new IDBFactory());});
describe("browser-approved XRP signing",{timeout:20000},()=>{
  it("converts XRP decimals without floating-point rounding",()=>{
    expect(parseXrp("1.000001")).toBe("1000001");expect(parseXrp("0.000001")).toBe("1");
    expect(formatXrp("9007199254740993")).toBe("9007199254.740993");
    for(const input of ["0","1e6","01","1.0000001","-1"," 1","100000000001"])expect(()=>parseXrp(input)).toThrow();
  });
  it.each(["amount","destination","tag","fee","total","sequence","ledger","digest","extra","partial","network"])("refuses changed preview %s before any decrypt",async field=>{
    const preview=await intent();const preparation=preview.preparation!;
    if(field==="amount")preview.amountDrops="2";
    if(field==="destination")preview.destination=source.classicAddress;
    if(field==="tag")delete preview.destinationTag;
    if(field==="fee")preparation.feeDrops="101";
    if(field==="total")preparation.totalDrops="1000000";
    if(field==="sequence")preparation.sequence=13;
    if(field==="ledger")preparation.lastLedgerSequence=9999;
    if(field==="digest")preparation.transactionDigest="A".repeat(64);
    if(field==="extra")(preparation.unsignedTransaction as any).Delegate=destination.classicAddress;
    if(field==="partial")preparation.unsignedTransaction.Flags=0x80020000;
    if(field==="network")(preview as any).network="mainnet";
    await expect(signApprovedPayment("1",source.classicAddress,phrase,preview)).rejects.toThrow();
    // No local vault was installed; format validation fails before storage access.
  });
  it.each([ECDSA.ed25519,ECDSA.secp256k1])("decrypts to sign one exact %s payment and returns only public signed evidence",async algorithm=>{
    const wallet=Wallet.generate(algorithm),preview=await intent(wallet.classicAddress);
    await saveLocalWallet({ownerId:"1",name:"Test",seed:wallet.seed!,seedConfirmation:wallet.seed!,passphrase:phrase,backupAcknowledged:true});
    await expect(assertPreparedPayment(preview,preview.preparation!,wallet.classicAddress)).resolves.toEqual(preview.preparation!.unsignedTransaction);
    const signed=await signApprovedPayment("1",wallet.classicAddress,phrase,preview);
    expect(verifySignature(signed.blob)).toBe(true);expect(hashes.hashSignedTx(signed.blob)).toBe(signed.hash);
    expect(JSON.stringify(signed)).not.toContain(wallet.seed!);expect(Object.keys(signed).sort()).toEqual(["blob","hash"]);
    await expect(signApprovedPayment("2",wallet.classicAddress,phrase,preview)).rejects.toThrow();
    await expect(signApprovedPayment("1",wallet.classicAddress,"wrong long passphrase",preview)).rejects.toThrow("UNLOCK_FAILED");
  });
  it("suppresses signatures when a lock interrupts password derivation",async()=>{
    const preview=await intent();await saveLocalWallet({ownerId:"1",name:"Test",seed:source.seed!,seedConfirmation:source.seed!,passphrase:phrase,backupAcknowledged:true});
    const controller=new AbortController();let began!:()=>void;const deriving=new Promise<void>(resolve=>{began=resolve;});
    const original=crypto.subtle.deriveKey.bind(crypto.subtle);
    const spy=vi.spyOn(crypto.subtle,"deriveKey").mockImplementation((...args)=>{began();return Reflect.apply(original,crypto.subtle,args);});
    try{
      const pending=signApprovedPayment("1",source.classicAddress,phrase,preview,controller.signal);
      await deriving;controller.abort();await expect(pending).rejects.toThrow();
    }finally{spy.mockRestore();}
  });
});
