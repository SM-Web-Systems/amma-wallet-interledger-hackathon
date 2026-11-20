import {randomUUID} from "node:crypto";
import {Wallet,decode,hashes,type Payment} from "xrpl";
import type {PaymentNetwork} from "../src/modules/xrpl/payment-service";
import type {AttemptInspection,ReconciliationEvidence} from "../src/modules/xrpl/reconciliation-adapter";
export const ledger=()=>({chain:"xrpl" as const,network:"testnet" as const,endpoint:"wss://testnet.xrpl-labs.com/",validatedLedgerIndex:1234,validatedLedgerHash:"A".repeat(64),observedAt:new Date().toISOString()});
export function offlineNetwork(onBroadcast:(blob:string)=>Promise<void>=async()=>{}) {
  let blob="",validated=false;
  const network:PaymentNetwork={
    getAccount:async address=>({...ledger(),address,funded:true,balanceDrops:"20000000",reserveDrops:"1000000",spendableDrops:"19000000",sequence:12,ownerCount:0,requiresDestinationTag:false}),
    getFee:async()=>({...ledger(),feeDrops:"12",currentLedgerIndex:1235}),getHealth:async()=>({...ledger(),status:"healthy"}),
    lookupTransaction:async hash=>({...ledger(),transactionHash:hash,status:"not_found",validated:false,authoritative:false}),
    inspectAttempt:async(input:AttemptInspection):Promise<ReconciliationEvidence>=>{
      const base={...ledger(),minLedger:input.minLedger,maxLedger:input.lastLedgerSequence,anchorHash:input.anchorHash};
      return validated&&blob&&input.hash===hashes.hashSignedTx(blob)?{...base,status:"validated",code:"VALIDATED_TRANSACTION",transaction:{...ledger(),status:"validated",transactionHash:hashes.hashSignedTx(blob),validated:true,ledgerIndex:1235,ledgerHash:"B".repeat(64),resultCode:"tesSUCCESS",transaction:decode(blob),metadata:{TransactionResult:"tesSUCCESS",delivered_amount:(decode(blob) as unknown as Payment).Amount}}}:{...base,status:"open",code:"AWAITING_LEDGER_BOUND"};
    },
    submitSigned:async saved=>{await onBroadcast(saved);blob=saved;validated=true;return {provisionalResult:"tesSUCCESS"};},
  };
  return network;
}
export const request=(walletId="1",reference=randomUUID())=>({schemaVersion:1,walletId,chain:"xrpl",network:"testnet",destination:Wallet.generate().classicAddress,destinationTag:0,amountDrops:"1000000",maxFeeDrops:"100",reference});
