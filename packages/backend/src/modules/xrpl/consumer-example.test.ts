import { describe,it,expect } from "vitest";
import { Wallet,decode,type Payment } from "xrpl";
import { randomUUID } from "node:crypto";
import { verifyReceipt,AmmaTestnetConsumer,type ExpectedPurchase,type RpcRead } from "../../examples/xrpl-consumer";
const source=Wallet.generate(),destination=Wallet.generate();
function fixture(){
  const expected:ExpectedPurchase={intentId:randomUUID(),purchaseId:randomUUID(),reference:randomUUID(),source:source.classicAddress,destination:destination.classicAddress,destinationTag:0,amountDrops:"1000000",maxFeeDrops:"100"};
  const transaction:Payment={TransactionType:"Payment",Account:expected.source,Destination:expected.destination,DestinationTag:0,Amount:"1000000",Fee:"12",Flags:0x80000000,Sequence:100,LastLedgerSequence:1050,Memos:[{Memo:{MemoType:Buffer.from("amma-reference").toString("hex").toUpperCase(),MemoData:Buffer.from(expected.reference).toString("hex").toUpperCase()}}]};
  const signed=source.sign(transaction);
  const receipt={schemaVersion:1,intentId:expected.intentId,chain:"xrpl",network:"testnet",validated:true,result:"tesSUCCESS",currency:"XRP",source:expected.source,destination:expected.destination,destinationTag:0,deliveredAmountDrops:"1000000",feeDrops:"12",reference:expected.reference,transactionHash:signed.hash,ledgerIndex:1024,ledgerHash:"A".repeat(64)};
  const data:Record<string,Record<string,unknown>>={server_info:{info:{network_id:1}},tx:{validated:true,hash:signed.hash,ledger_index:1024,tx_json:decode(signed.tx_blob),meta:{TransactionResult:"tesSUCCESS",delivered_amount:"1000000"}},ledger:{validated:true,ledger_index:1024,ledger_hash:"A".repeat(64)}};
  const read:RpcRead=async request=>data[String(request.command)];return {expected,receipt,data,read,transaction};
}
describe("independent settlement verifier example",()=>{
  it("verifies the signed canonical transaction, delivered value, memo, ledger and Testnet",async()=>{
    const f=fixture();expect(await verifyReceipt(f.expected,f.receipt,f.read)).toEqual({transactionHash:f.receipt.transactionHash,ledgerIndex:1024});
    const tx=f.data.tx.tx_json as Record<string,unknown>;tx.DeliverMax=tx.Amount;delete tx.Amount;
    const memo=(tx.Memos as {Memo:{MemoType:string;MemoData:string}}[])[0].Memo;
    tx.Memos=[{Memo:{MemoData:memo.MemoData.toLowerCase(),MemoType:memo.MemoType.toLowerCase()}}];
    expect((await verifyReceipt(f.expected,f.receipt,f.read)).transactionHash).toBe(f.receipt.transactionHash);
  });
  it.each(["network","pending","wrong_hash","wrong_ledger","partial_delivery","failed","partial_flag","extra_field","both_amount_names","tag_missing","wrong_reference","wrong_signer"])("rejects an independently observed %s",async mode=>{
    const f=fixture(),tx=f.data.tx.tx_json as Record<string,unknown>;
    if(mode==="network")f.data.server_info.info={network_id:0};
    if(mode==="pending")f.data.tx.validated=false;
    if(mode==="wrong_hash")f.data.tx.hash="B".repeat(64);
    if(mode==="wrong_ledger")f.data.ledger.ledger_hash="B".repeat(64);
    if(mode==="partial_delivery")f.data.tx.meta={TransactionResult:"tesSUCCESS",delivered_amount:"1"};
    if(mode==="failed")f.data.tx.meta={TransactionResult:"tecPATH_DRY",delivered_amount:"1000000"};
    if(mode==="partial_flag")tx.Flags=0x80020000;
    if(mode==="extra_field")tx.SendMax="1000001";
    if(mode==="both_amount_names")tx.DeliverMax=tx.Amount;
    if(mode==="tag_missing")delete tx.DestinationTag;
    if(mode==="wrong_reference")tx.Memos=[];
    if(mode==="wrong_signer"){
      const signed=destination.sign(f.transaction);f.receipt.transactionHash=signed.hash;f.data.tx.hash=signed.hash;f.data.tx.tx_json=decode(signed.tx_blob);
    }
    await expect(verifyReceipt(f.expected,f.receipt,f.read)).rejects.toThrow();
  });
  it("compares receipt data against the consumer's purchase and fee ceiling",async()=>{
    const f=fixture();await expect(verifyReceipt({...f.expected,amountDrops:"2"},f.receipt,f.read)).rejects.toThrow();
    await expect(verifyReceipt({...f.expected,maxFeeDrops:"1"},f.receipt,f.read)).rejects.toThrow();
  });
  it("keeps application credentials on a configured HTTPS or loopback origin",()=>{
    for(const origin of ["http://evil.invalid","https://evil.invalid/path","https://user:password@evil.invalid","https://evil.invalid/?redirect=x"]){expect(()=>new AmmaTestnetConsumer(origin,"synthetic-token","synthetic-key")).toThrow();}
  });
});
