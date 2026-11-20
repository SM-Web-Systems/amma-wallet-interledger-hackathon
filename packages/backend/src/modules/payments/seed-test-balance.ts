import 'dotenv/config';
import postgres from 'postgres';
import { resolveDatabaseUrl } from '../../lib/docker-secrets';
import { postgresDatabase } from './runtime';
import { PaymentStore } from './store';
import { assetEnvironment, assetKey, requireThat, units, type Asset } from './domain';
/**
 * TEST ONLY. Credits one customer's managed balance in a disposable database with
 * a single, labelled clearing -> customer ledger posting, so an end-to-end run
 * against isolated Rafiki peers has something to spend. Refuses production, live
 * assets and any database not named with the explicit `--expect-database=` value.
 *
 *   npx tsx src/modules/payments/seed-test-balance.ts --test-only --expect-database=NAME \
 *     --owner=1 --amount=50000000 --asset='{"chain":"stellar","network":"testnet",...}'
 */
async function main() {
  const arg=(name:string)=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
  requireThat(process.argv.includes('--test-only')&&process.env.NODE_ENV!=='production','TEST_ONLY_COMMAND');
  const expected=arg('expect-database'),owner=Number(arg('owner')),amount=arg('amount')??'',asset=JSON.parse(arg('asset')??'null') as Asset;
  requireThat(expected&&/^[a-z0-9_]*test[a-z0-9_]*$/.test(expected),'TEST_DATABASE_NAME_REQUIRED');
  requireThat(Number.isSafeInteger(owner)&&owner>0,'INVALID_OWNER');units(amount);assetKey(asset);
  requireThat(assetEnvironment(asset)==='test','LIVE_ASSET_REFUSED');
  const connection=postgres(resolveDatabaseUrl(),{max:1,connect_timeout:10,onnotice:()=>{}});
  try {
    const store=new PaymentStore(postgresDatabase(connection));
    const [{name}]=await store.db.query<{name:string}>('SELECT current_database() AS name');
    requireThat(name===expected,'DATABASE_IDENTITY_MISMATCH');
    const reference=`test-seed:${owner}:${assetKey(asset)}:${amount}`;
    await store.db.transaction(async tx=>{
      const clearing=await store.account(tx,0,asset,'clearing'),customer=await store.account(tx,owner,asset);
      await store.transfer(tx,clearing,customer,asset,amount,reference);
    });
    console.log(JSON.stringify({seeded:true,owner,assetKey:assetKey(asset),amount,reference}));
  } finally {await connection.end({timeout:5});}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Seed failed');process.exitCode=1;});
