import postgres from "postgres";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {applyChainStorage} from "../src/db/migrations/chain-storage";
import {applyPaymentStorage} from "../src/db/migrations/xrpl-payments";
import {applyReconciliationStorage} from "../src/db/migrations/xrpl-reconciliation";
import {applyIntegrationStorage} from "../src/db/migrations/xrpl-integration";

export function acceptanceUrl(env:NodeJS.ProcessEnv=process.env):string {
  if(env.XRPL_ACCEPTANCE_SANDBOX!=="true"||env.STELLAR_NETWORK!=="testnet"||env.XRPL_NETWORK!=="testnet")throw new Error("Explicit isolated acceptance environment required");
  const url=new URL(env.DATABASE_URL??""),expected=env.XRPL_ACCEPTANCE_DATABASE;
  if(!expected||!/^amma_xrpl_acceptance_[a-z0-9_]+$/.test(expected)||decodeURIComponent(url.pathname.slice(1))!==expected||!["127.0.0.1","localhost","xrpl-acceptance-db"].includes(url.hostname)||!["postgres:","postgresql:"].includes(url.protocol)||url.search||url.hash)throw new Error("Acceptance database identity rejected");
  return url.href;
}
export async function assertFixture(client:ReturnType<typeof postgres>) {
  const [identity]=await client`SELECT current_database() AS name,current_setting('server_version_num')::int AS version`;
  if(identity.name!==process.env.XRPL_ACCEPTANCE_DATABASE||identity.version<160000||identity.version>=170000)throw new Error("Isolated PostgreSQL 16 identity required");
}
export async function bootstrapFixture(client:ReturnType<typeof postgres>){
  await assertFixture(client);
  const tables=await client`SELECT tablename FROM pg_tables WHERE schemaname='public'`;
  if(tables.length)throw new Error("Acceptance bootstrap requires an empty dedicated database; no reset/drop is performed");
  await client.begin(async tx=>{
    const history=["0000_dry_micromacro.sql","0002_concerned_thunderbolts.sql"].map(name=>readFileSync(resolve("drizzle",name),"utf8")).join("\n");
    for(const name of ["users","user_wallets","tx_history","address_book","portfolio_snapshots"]){const ddl=history.match(new RegExp(`CREATE TABLE "${name}" \\([\\s\\S]*?\\n\\);`));if(!ddl)throw new Error("Baseline fixture DDL missing");await tx.unsafe(ddl[0]);}
    const tenants=readFileSync(resolve("drizzle/0003_petite_emma_frost.sql"),"utf8");
    for(const name of ["tenants","tenant_api_keys","tenant_users"]){const start=tenants.indexOf(`CREATE TABLE "${name}" (`);if(start<0)throw new Error("Tenant fixture DDL missing");await tx.unsafe(tenants.slice(start,tenants.indexOf("\n);",start)+3));}
    await tx.unsafe("CREATE UNIQUE INDEX idx_user_wallets_user_pubkey ON user_wallets(user_id,public_key);ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_user_id_users_id_fk FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE;INSERT INTO users(id,email,password_hash) VALUES(1,'one@example.invalid','unused'),(2,'two@example.invalid','unused');CREATE TABLE xrpl_acceptance_fixture(id integer PRIMARY KEY CHECK(id=1),purpose text NOT NULL);INSERT INTO xrpl_acceptance_fixture VALUES(1,'disposable offline financial acceptance only')");
  });
  class Rehearsal extends Error{}
  const migrate=async(commit:boolean)=>{
    try{await client.begin(async tx=>{
      const connection={execute:async(statement:string)=>{await tx.unsafe(statement);},rows:async<T extends Record<string,unknown>>(statement:string)=>Array.from(await tx.unsafe<T[]>(statement))};
      for(const apply of [applyChainStorage,applyPaymentStorage,applyReconciliationStorage,applyIntegrationStorage])await apply(connection);
      if(!commit)throw new Rehearsal();
    });}catch(cause){if(!(cause instanceof Rehearsal))throw cause;}
  };
  await migrate(false);
  if((await client`SELECT to_regclass('public.xrpl_payments') AS name`)[0].name!==null)throw new Error("Migration rehearsal did not roll back");
  await migrate(true);await migrate(true);
}
