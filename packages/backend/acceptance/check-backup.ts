import postgres from "postgres";
import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {acceptanceUrl,assertFixture} from "./database";
async function main(){
  const mode=process.argv[2],file=process.argv[3];if(!["--source","--restored"].includes(mode)||!file)throw new Error("Explicit comparison mode/file required");
  const pg=postgres(acceptanceUrl(),{max:1});try{
    await assertFixture(pg);await pg`SELECT purpose FROM xrpl_acceptance_fixture WHERE id=1`;
    const summary={payments:(await pg`SELECT count(*)::int AS n FROM xrpl_payments`)[0].n,events:(await pg`SELECT count(*)::int AS n FROM xrpl_payment_events`)[0].n,claims:(await pg`SELECT count(*)::int AS n FROM xrpl_receipt_claims`)[0].n,
      markers:Array.from(await pg`SELECT version,checksum FROM amma_chain_migrations ORDER BY version`)};
    if(summary.payments<1||summary.claims<1)throw new Error("Nonempty financial restore fixture required");
    if(mode==="--source")writeFileSync(resolve(file),JSON.stringify(summary),{flag:"wx"});
    else {if(JSON.stringify(summary)!==JSON.stringify(JSON.parse(readFileSync(resolve(file),"utf8"))))throw new Error("Restore comparison mismatch");console.log(JSON.stringify({status:"passed",scope:"PG16 custom-format dump/restore of disposable offline fixture",payments:summary.payments,events:summary.events,claims:summary.claims,matchingMigrationChecksums:true}));}
  }finally{await pg.end({timeout:5});}
}
main().catch(()=>{console.error("Disposable backup/restore comparison failed; details redacted");process.exit(1);});
