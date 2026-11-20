// Disposable PG16/production-image process recovery probe. Never public RPC.
import postgres from "postgres";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {decode,hashes} from "xrpl";
import {acceptanceUrl,assertFixture} from "./database";
import {offlineNetwork,ledger} from "./fixtures";
import {XrplPaymentService} from "../src/modules/xrpl/payment-service";
async function main(){
  const url=acceptanceUrl(),id=process.argv[2];if(!/^[a-f0-9-]{36}$/.test(id??""))throw new Error("Fixture intent required");
  const client=postgres(url,{max:2,connection:{statement_timeout:10000}});await assertFixture(client);
  await client`SELECT purpose FROM xrpl_acceptance_fixture WHERE id=1`;
  const [row]=await client`SELECT * FROM xrpl_payments WHERE id=${id}`;if(!row?.signed_blob||row.state!=="signed")throw new Error("Saved signed fixture required");
  const mode=process.env.XRPL_ACCEPTANCE_PHASE_FILE?readFileSync(resolve(process.env.XRPL_ACCEPTANCE_PHASE_FILE),"utf8").trim():process.env.XRPL_ACCEPTANCE_PHASE;
  if(!["stall","recover"].includes(mode??""))throw new Error("Explicit fixture phase required");
  const emit=(event:string)=>{if(process.send)process.send({event});else console.log(JSON.stringify({event}));};
  let broadcast=false;const network=offlineNetwork(async blob=>{if(blob!==row.signed_blob||hashes.hashSignedTx(blob)!==row.transaction_hash)throw new Error("Saved blob changed");broadcast=true;});
  const inspect=network.inspectAttempt;
  network.inspectAttempt=async input=>{
    if(mode==="stall"){emit("xrpl_acceptance_lease_claimed");await new Promise(()=>{setInterval(()=>{},1000);});}
    if(broadcast)return {...ledger(),minLedger:input.minLedger,maxLedger:input.lastLedgerSequence,anchorHash:input.anchorHash,status:"validated",code:"VALIDATED_TRANSACTION",transaction:{...ledger(),status:"validated",transactionHash:row.transaction_hash,validated:true,ledgerIndex:1235,ledgerHash:"B".repeat(64),resultCode:"tesSUCCESS",transaction:decode(row.signed_blob),metadata:{TransactionResult:"tesSUCCESS",delivered_amount:row.request.amountDrops}}};
    return inspect(input);
  };
  await new XrplPaymentService(network,()=>{}).reconcileBatch(1,true);
  const [saved]=await client`SELECT state,transaction_hash,broadcast_attempts FROM xrpl_payments WHERE id=${id}`;
  if(saved.state!=="validated_success"||saved.transaction_hash!==row.transaction_hash||saved.broadcast_attempts!==1)throw new Error("Recovery assertion failed");
  await client.end();emit("xrpl_acceptance_recovered");process.exit(0);
}
main().catch(()=>{console.error("XRPL disposable recovery check failed; details redacted");process.exit(1);});
