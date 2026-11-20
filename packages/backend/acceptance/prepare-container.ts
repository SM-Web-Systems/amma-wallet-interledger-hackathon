import {writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";
import postgres from "postgres";
import {Wallet} from "xrpl";
import {acceptanceUrl,bootstrapFixture} from "./database";
import {offlineNetwork,request} from "./fixtures";
import {XrplPaymentService} from "../src/modules/xrpl/payment-service";
import {validateSigned} from "../src/modules/xrpl/payment";
async function main(){
  const pg=postgres(acceptanceUrl(),{max:2});try{
    await bootstrapFixture(pg);const source=Wallet.generate();
    await pg`INSERT INTO user_wallets(id,user_id,name,public_key,chain,network) VALUES(1,1,'Disposable offline fixture',${source.classicAddress},'xrpl','testnet')`;
    const api=new XrplPaymentService(offlineNetwork(),()=>{}),created=await api.create(1,request(),randomUUID()),prepared=await api.prepare(1,created.id),p=prepared.preparation!,signed=validateSigned(source.sign(p.unsignedTransaction).tx_blob,p,prepared,source.classicAddress);
    await pg`UPDATE xrpl_payments SET state='signed',signed_blob=${signed.blob},transaction_hash=${signed.hash},next_reconcile_at=now() WHERE id=${created.id}`;
    writeFileSync(resolve(process.env.XRPL_ACCEPTANCE_ID_FILE??"acceptance-id.tmp"),created.id+"\n",{flag:"wx"});console.log(JSON.stringify({fixture:"prepared",scope:"offline synthetic ledger only"}));
  }finally{await pg.end({timeout:5});}
}
main().catch(()=>{console.error("Disposable container fixture preparation failed; details redacted");process.exit(1);});
