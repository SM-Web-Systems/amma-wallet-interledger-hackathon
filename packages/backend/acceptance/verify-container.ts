import postgres from "postgres";
import {acceptanceUrl,assertFixture} from "./database";
async function main(){
  const pg=postgres(acceptanceUrl(),{max:1});try{
    await assertFixture(pg);await pg`SELECT purpose FROM xrpl_acceptance_fixture WHERE id=1`;
    if(process.argv[2]==="--expire-lease"){
      const rows=await pg`UPDATE xrpl_payments SET lease_expires_at=now()-interval '1 second' WHERE state='signed' AND lease_token IS NOT NULL RETURNING id`;if(rows.length!==1)throw new Error("Expected one interrupted fixture");
    }else{
      const rows=await pg`SELECT state,transaction_hash,receipt,broadcast_attempts FROM xrpl_payments`;if(rows.length!==1||rows[0].state!=="validated_success"||rows[0].broadcast_attempts!==1||rows[0].receipt.transactionHash!==rows[0].transaction_hash)throw new Error("Recovery evidence missing");
      console.log(JSON.stringify({status:"passed",scope:"production image, offline ledger, PostgreSQL 16, SIGKILL/restart",sameSavedHash:true,broadcastAttempts:1}));
    }
  }finally{await pg.end({timeout:5});}
}
main().catch(()=>{console.error("Disposable container recovery verification failed; details redacted");process.exit(1);});
