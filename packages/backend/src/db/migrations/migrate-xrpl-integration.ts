import postgres from "postgres";
import {resolveDatabaseUrl} from "../../lib/docker-secrets";
import {applyIntegrationStorage} from "./xrpl-integration";
import {XRPL_RUNNER_REFUSED,xrplRunnerAllowed} from "./xrpl-runner";
class CheckRollback extends Error{}
async function main(){
  const args=process.argv.slice(2),mode=args[0],expected=args.find(arg=>arg.startsWith("--expect-database="))?.slice(18);
  if(!["--check","--apply"].includes(mode)||!expected||args.length!==2)throw new Error("Usage: --check|--apply --expect-database=NAME");
  if(!xrplRunnerAllowed(process.env))throw new Error(XRPL_RUNNER_REFUSED); // isolated testnet, or mainnet only with XRPL_MAINNET_CUSTODY=on
  const client=postgres(resolveDatabaseUrl(),{max:1,connect_timeout:10,onnotice:()=>{}});let outcome="";
  try{await client.begin(async tx=>{
    await tx.unsafe("SET LOCAL lock_timeout='5s'");await tx.unsafe("SET LOCAL statement_timeout='60s'");
    const [identity]=await tx.unsafe<{name:string}[]>("SELECT current_database() AS name");if(identity.name!==expected)throw new Error("Database identity mismatch");
    outcome=await applyIntegrationStorage({execute:async statement=>{await tx.unsafe(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>Array.from(await tx.unsafe<T[]>(statement))});
    if(mode==="--check")throw new CheckRollback();
  });}catch(cause){if(!(cause instanceof CheckRollback))throw cause;}finally{await client.end({timeout:5});}
  console.log(JSON.stringify({migration:"xrpl-integration-v1",mode,outcome,committed:mode==="--apply"}));
}
main().catch(()=>{console.error("Integration migration did not complete cleanly. Recheck marker, checksum and database identity before retrying.");process.exitCode=1;});
