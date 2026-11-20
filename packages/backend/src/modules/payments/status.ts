import 'dotenv/config';
import postgres from 'postgres';
import {resolveDatabaseUrl} from '../../lib/docker-secrets';
async function main(){
  const sql=postgres(resolveDatabaseUrl(),{max:1});
  try{
    const jobs=await sql`SELECT kind,state,count(*)::text AS count,min(created_at) AS oldest,max(attempts) AS max_attempts FROM payment_jobs GROUP BY kind,state ORDER BY kind,state`;
    const unbalanced=await sql`SELECT count(*)::text AS count FROM payment_accounts a WHERE a.balance<>(
      COALESCE((SELECT sum(amount) FROM payment_ledger WHERE credit_account=a.id),0)-COALESCE((SELECT sum(amount) FROM payment_ledger WHERE debit_account=a.id),0))`;
    const held=await sql`SELECT asset_key,sum(balance)::text AS reserved FROM payment_accounts WHERE kind='reserved' GROUP BY asset_key ORDER BY asset_key`;
    console.log(JSON.stringify({jobs,ledgerBalanceMismatches:unbalanced[0].count,held},null,2));
  }finally{await sql.end();}
}
main().catch(()=>{console.error('Payment status unavailable. Verify database connectivity and migration.');process.exitCode=1;});
