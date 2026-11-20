import postgres from "postgres";
import {resolveDatabaseUrl} from "../lib/docker-secrets";
import {stagingIdentity} from "./staging-config";
import {submissionAvailability} from "../modules/xrpl/submission-control";
import {collectOperations} from "../modules/xrpl/operations";
import {readMonitorConfig} from "../modules/xrpl/config";
import {verifyExistingStorage} from "./schema-verification";
async function main(){
  const identity=stagingIdentity(process.argv.slice(2)),url=new URL(resolveDatabaseUrl());
  if(url.hostname!==identity.host||decodeURIComponent(url.pathname.slice(1))!==identity.database)throw new Error("Database identity mismatch");
  if(submissionAvailability().code!=="XRPL_SUBMISSION_PAUSED")throw new Error("Operator pause must be active during preflight");
  const client=postgres(url.href,{max:1,connect_timeout:5,connection:{statement_timeout:10000}});
  try{await client.begin(async tx=>{
    await tx.unsafe("SET TRANSACTION READ ONLY");
    const [database]=await tx.unsafe("SELECT current_database() AS name,current_setting('server_version_num')::int AS version");
    if(database.name!==identity.database||database.version<160000||database.version>=170000)throw new Error("Reviewed PostgreSQL 16 identity required");
    const connection={execute:async(statement:string)=>{await tx.unsafe(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>Array.from(await tx.unsafe<T[]>(statement))};
    await verifyExistingStorage(connection);
  });}finally{await client.end({timeout:5});}
  const operations=await collectOperations(readMonitorConfig());
  if(operations.status!=="healthy"||operations.endpoints.length!==2||operations.endpoints.some(endpoint=>endpoint.status!=="healthy"))throw new Error("Healthy endpoints and clean pending queue required");
  console.log(JSON.stringify({status:"passed",scope:"read-only isolated Testnet preflight, not release authorization",revision:identity.revision,migrationChecksumsVerified:true,submissionPaused:true,operations}));
  process.exit(0);
}
main().catch(()=>{console.error(JSON.stringify({status:"blocked",code:"STAGING_PREFLIGHT_FAILED",message:"Check reviewed revision, isolated database identity/schema, pause control and endpoint/queue health. No migrations or deployment performed."}));process.exit(1);});
