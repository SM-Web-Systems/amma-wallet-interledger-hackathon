// TEST-ONLY live acceptance driver for the isolated two-peer Rafiki stack (docker/interledger).
// Runs inside the Amma backend-under-test container: npx tsx acceptance/ilp-live.ts <command> [args]
// Prints JSON evidence only: no secrets, tokens or connection strings.
import jwt from 'jsonwebtoken';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {createAuthenticatedClient,isFinalizedGrantWithAccessToken} from '@interledger/open-payments';
import {RafikiAdmin,signature} from '../src/modules/payments/rafiki';

const env=(name:string)=>{const value=process.env[name];if(!value)throw new Error(`missing ${name}`);return value;};
if(process.env.NODE_ENV==='production')throw new Error('test-only driver');
const base='http://127.0.0.1:3001/api/v1/payments';
const sql=postgres(env('DATABASE_URL'),{max:2,onnotice:()=>{}});
const adminA=new RafikiAdmin(env('PEER_A_ADMIN_URL'),env('PEER_A_TENANT_ID'),env('PEER_A_ADMIN_SECRET'));
const adminB=new RafikiAdmin(env('PEER_B_ADMIN_URL'),env('PEER_B_TENANT_ID'),env('PEER_B_ADMIN_SECRET'));
const asset=JSON.parse(env('PAYMENTS_RAFIKI_ASSETS'))[0].asset;
const token=(userId:number)=>jwt.sign({userId,email:null,type:'user'},env('JWT_SECRET'),{expiresIn:'2h'});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const out=(label:string,data:unknown)=>console.log(JSON.stringify({step:label,...(data as object)}));

async function api(method:string,path:string,body?:unknown,opts:{user?:number;key?:string}={}){
  const headers:Record<string,string>={Authorization:`Bearer ${token(opts.user??1)}`};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=opts.key??randomUUID();}
  const res=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await res.text();let json:any;try{json=JSON.parse(text);}catch{json=text;}
  return {status:res.status,body:json};
}
async function invariants(label:string){
  const [m]=await sql`SELECT count(*)::int AS n FROM payment_accounts a WHERE a.balance<>(
    COALESCE((SELECT sum(amount) FROM payment_ledger WHERE credit_account=a.id),0)-COALESCE((SELECT sum(amount) FROM payment_ledger WHERE debit_account=a.id),0))`;
  const [t]=await sql`SELECT COALESCE(sum(balance),0)::text AS total, count(*)::int AS accounts FROM payment_accounts`;
  const held=await sql`SELECT COALESCE(sum(balance),0)::text AS held FROM payment_accounts WHERE kind='reserved'`;
  const customers=await sql`SELECT owner_id::int AS owner, balance::text FROM payment_accounts WHERE kind='customer' ORDER BY owner_id`;
  const r={mismatches:m.n,ledgerSum:t.total,accounts:t.accounts,held:held[0].held,customers};
  out(`invariants:${label}`,r);
  if(m.n!==0||t.total!=='0')throw new Error('LEDGER INVARIANT BROKEN');
  return r;
}
async function peerLiquidity(){
  const q=`query P{peers(first:10){edges{node{id name liquidity}}}}`;
  const [a,b]=await Promise.all([adminA.call(q,{}),adminB.call(q,{})]);
  return {a:a.peers.edges.map((e:any)=>({id:e.node.id,name:e.node.name,liquidity:String(e.node.liquidity)})),
    b:b.peers.edges.map((e:any)=>({id:e.node.id,name:e.node.name,liquidity:String(e.node.liquidity)}))};
}
async function waitExecution(id:string,states:string[],timeoutMs=120_000,user=1){
  const end=Date.now()+timeoutMs;let last:any;
  while(Date.now()<end){last=(await api('GET',`/executions/${id}`,undefined,{user})).body;if(states.includes(last.state))return last;await sleep(2000);}
  throw new Error(`execution ${id} stuck in ${last?.state}`);
}
async function incomingAtB(url:string){
  const id=new URL(url).pathname.split('/').pop();
  const d=await adminB.call(`query I($id:String!){incomingPayment(id:$id){id state receivedAmount{value} incomingAmount{value}}}`,{id});
  return {state:d.incomingPayment.state,received:d.incomingPayment.receivedAmount.value,incoming:d.incomingPayment.incomingAmount?.value};
}
async function startPayment(amount:string,user=1){
  const invoice=await api('POST','/requests/remote',{walletAddress:env('PEER_B_CLIENT_ADDRESS'),asset,amount},{user});
  if(invoice.status!==200)throw new Error(`invoice ${invoice.status} ${JSON.stringify(invoice.body)}`);
  const quote=await api('POST','/quotes',{requestId:invoice.body.id},{user});
  if(quote.status!==200)throw new Error(`quote ${quote.status} ${JSON.stringify(quote.body)}`);
  return {invoice:invoice.body,quote:quote.body};
}
async function approve(quote:any,user=1,key?:string){return api('POST','/approvals',{quoteId:quote.id,hash:quote.hash},{user,key});}
async function customerAddress(user=1){
  const list=(await api('GET','/addresses',undefined,{user})).body;if(Array.isArray(list)&&list.length)return list[0].url as string;
  const r=await api('POST','/addresses',{asset,publicName:`Test customer ${user}`},{user});if(r.status!==200)throw new Error(`address ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.url??r.body.address??r.body) as string;
}
const clientB=async()=>createAuthenticatedClient({walletAddressUrl:env('PEER_B_CLIENT_ADDRESS'),keyId:env('PEER_B_KEY_ID'),
  privateKey:fs.readFileSync(env('PEER_B_PRIVATE_KEY_FILE'),'utf8'),requestTimeoutMs:10_000,logLevel:'silent'} as any);
const bWalletId=async()=>(await adminB.call(`query W($url:String!){walletAddressByUrl(url:$url){id}}`,{url:env('PEER_B_CLIENT_ADDRESS')})).walletAddressByUrl.id as string;
async function bPays(receiver:string){
  const wallet=await bWalletId();
  const q=await adminB.call(`mutation Q($input:CreateQuoteInput!){createQuote(input:$input){quote{id debitAmount{value} receiveAmount{value}}}}`,{input:{walletAddressId:wallet,receiver,idempotencyKey:randomUUID()}});
  const o=await adminB.call(`mutation O($input:CreateOutgoingPaymentInput!){createOutgoingPayment(input:$input){payment{id state}}}`,{input:{walletAddressId:wallet,quoteId:q.createQuote.quote.id,idempotencyKey:randomUUID()}});
  const d=await adminB.call(`mutation D($input:DepositOutgoingPaymentLiquidityInput!){depositOutgoingPaymentLiquidity(input:$input){success}}`,{input:{outgoingPaymentId:o.createOutgoingPayment.payment.id,idempotencyKey:randomUUID()}});
  return {quote:q.createQuote.quote,outgoing:o.createOutgoingPayment.payment.id,funded:d.depositOutgoingPaymentLiquidity.success};
}
const debitOf=(quote:any)=>String(quote.rail?.debit??quote.rail?.debitAmount?.value??'');

const commands:Record<string,(args:string[])=>Promise<void>>={
  async invariants(args){await invariants(args[0]??'check');},
  async liquidity(){out('liquidity',await peerLiquidity());},
  async pay([amount='1234567',user='1']){
    const before=await peerLiquidity();await invariants('before-pay');
    const {invoice,quote}=await startPayment(amount,Number(user));
    const approved=await approve(quote,Number(user));
    if(approved.status!==200)throw new Error(`approve ${approved.status} ${JSON.stringify(approved.body)}`);
    const done=await waitExecution(approved.body.id,['paid','recovery','recovered'],120_000,Number(user));
    const receipt=await api('GET',`/executions/${done.id}/receipt`,undefined,{user:Number(user)});
    await sleep(3000);
    const after=await peerLiquidity();
    const ledger=await sql`SELECT reference,amount::text FROM payment_ledger WHERE reference LIKE ${'%'+done.id+'%'} OR reference LIKE ${'%'+(done.legs?.[0]?.id??'none')+'%'} ORDER BY created_at`;
    out('pay',{amount,invoice:invoice.id,quoteDebit:debitOf(quote),execution:done.id,state:done.state,receiptStatus:receipt.status,
      receipt:receipt.body,incomingAtB:await incomingAtB(invoice.incomingPayment),peerLiquidityBefore:before,peerLiquidityAfter:after,ledger});
    await invariants('after-pay');
  },
  async start([amount='1000000',user='1']){
    // Approve and return at once (for kill/restart and concurrency rehearsals).
    const {invoice,quote}=await startPayment(amount,Number(user));const approved=await approve(quote,Number(user));
    out('start',{execution:approved.body.id,status:approved.status,state:approved.body.state,incoming:invoice.incomingPayment});
  },
  async wait([id,user='1']){const done=await waitExecution(id,['paid','recovery','recovered'],180_000,Number(user));
    const n=await sql`SELECT count(*)::int AS n FROM payment_ledger WHERE reference LIKE ${'%'+id+'%'}`;
    out('wait',{execution:id,state:done.state,error:done.error,ledgerRows:n[0].n,outgoing:done.outgoing});await invariants(`after-${id.slice(0,8)}`);},
  async expired([amount='500000']){
    const {quote}=await startPayment(amount);const waitMs=Date.parse(quote.expiresAt)-Date.now()+2000;
    out('expired:waiting',{quoteExpiresAt:quote.expiresAt,waitSeconds:Math.round(waitMs/1000)});
    if(waitMs>15*60_000)throw new Error('quote lifetime too long to rehearse');
    const ledgerBefore=(await sql`SELECT count(*)::int AS n FROM payment_ledger`)[0].n;
    await sleep(Math.max(0,waitMs));const r=await approve(quote);
    const ledgerAfter=(await sql`SELECT count(*)::int AS n FROM payment_ledger`)[0].n;
    out('expired',{approveStatus:r.status,code:r.body?.error?.code,ledgerRowsBefore:ledgerBefore,ledgerRowsAfter:ledgerAfter});
    await invariants('after-expired');
  },
  async replay(){
    const [w]=await sql`SELECT payload FROM payment_webhooks ORDER BY created_at DESC LIMIT 1`;if(!w)throw new Error('no stored webhook');
    const body=w.payload,secret=env('RAFIKI_WEBHOOK_SECRET');
    const before=await sql`SELECT (SELECT count(*) FROM payment_webhooks)::int AS webhooks,(SELECT count(*) FROM payment_jobs)::int AS jobs,(SELECT count(*) FROM payment_ledger)::int AS ledger`;
    const post=async(b:unknown,s:string)=>{const r=await fetch(base+'/webhooks/rafiki',{method:'POST',headers:{'Content-Type':'application/json','rafiki-signature':signature(s,b)},body:JSON.stringify(b)});return r.status;};
    const same1=await post(body,secret),same2=await post(body,secret);
    const changed=await post({...body,data:{...body.data,tampered:true}},secret);
    const wrong=await post(body,'x'.repeat(64));
    await sleep(7000);
    const after=await sql`SELECT (SELECT count(*) FROM payment_webhooks)::int AS webhooks,(SELECT count(*) FROM payment_jobs)::int AS jobs,(SELECT count(*) FROM payment_ledger)::int AS ledger`;
    out('replay',{type:body.type,sameBodyTwice:[same1,same2],changedBody:changed,wrongSecret:wrong,before:before[0],after:after[0]});
    await invariants('after-replay');
  },
  async withdrawPeerLiquidity([keep='100',side='b']){
    const admin=side==='a'?adminA:adminB;const peer=(await peerLiquidity())[side as 'a'|'b'][0];const amount=(BigInt(peer.liquidity)-BigInt(keep)).toString();
    const r=await admin.call(`mutation W($input:CreatePeerLiquidityWithdrawalInput!){createPeerLiquidityWithdrawal(input:$input){success}}`,
      {input:{peerId:peer.id,amount,id:randomUUID(),idempotencyKey:randomUUID(),timeoutSeconds:'0'}});
    out('withdrawPeerLiquidity',{side,peer:peer.name,withdrawn:amount,success:r.createPeerLiquidityWithdrawal.success,after:(await peerLiquidity())[side as 'a'|'b']});
  },
  async restorePeerLiquidity([amount='1000000000000',side='b']){
    const admin=side==='a'?adminA:adminB;const peer=(await peerLiquidity())[side as 'a'|'b'][0];
    const r=await admin.call(`mutation D($input:DepositPeerLiquidityInput!){depositPeerLiquidity(input:$input){success}}`,
      {input:{peerId:peer.id,amount,id:randomUUID(),idempotencyKey:randomUUID()}});
    out('restorePeerLiquidity',{side,success:r.depositPeerLiquidity.success,after:(await peerLiquidity())[side as 'a'|'b']});
  },
  async payIn([amount='700000',waitSec='90',user='1']){
    // An external sender (peer B) creates an incoming payment on an Amma customer address and pays it.
    await invariants('before-payIn');const addr=await customerAddress(Number(user));const client=await clientB();
    const wallet=await client.walletAddress.get({url:addr});
    const grant:any=await client.grant.request({url:wallet.authServer},{access_token:{access:[{type:'incoming-payment',actions:['create','read']}]}} as any);
    if(!isFinalizedGrantWithAccessToken(grant))throw new Error('incoming grant not issued');
    const incoming=await client.incomingPayment.create({url:wallet.resourceServer,accessToken:grant.access_token.value},
      {walletAddress:wallet.id,incomingAmount:{value:amount,assetCode:asset.code,assetScale:asset.scale},expiresAt:new Date(Date.now()+10*60_000).toISOString()} as any);
    const id=new URL(incoming.id).pathname.split('/').pop()!;const paid=await bPays(incoming.id);
    let atA:any,credited:any[]=[];const end=Date.now()+Number(waitSec)*1000;
    while(Date.now()<end){
      atA=(await adminA.call(`query I($id:String!){incomingPayment(id:$id){state receivedAmount{value}}}`,{id})).incomingPayment;
      credited=await sql`SELECT amount::text FROM payment_ledger WHERE reference=${'incoming:'+id}`;if(credited.length)break;await sleep(3000);
    }
    const jobs=await sql`SELECT kind,state FROM payment_jobs WHERE id=${id}`;
    const webhooks=await sql`SELECT payload->>'type' AS type FROM payment_webhooks WHERE payload->'data'->>'id' LIKE ${'%'+id}`;
    out('payIn',{address:addr,incoming:id,amount,senderQuote:paid.quote,funded:paid.funded,atA,credited:credited[0]?.amount??null,catchUpJob:jobs[0]??null,webhooksReceived:webhooks.map(w=>w.type)});
    await invariants('after-payIn');
  },
  async gnap([limit='3000000',amount='1000000',user='1']){
    // Third-party client (peer B's wallet) asks to spend from an Amma customer address; the customer consents through Amma.
    await invariants('before-gnap');const addr=await customerAddress(Number(user));const client=await clientB();
    const wallet=await client.walletAddress.get({url:addr});const nonce=randomUUID();
    const access=[{type:'outgoing-payment',actions:['create','read','list'],identifier:wallet.id,limits:{debitAmount:{value:limit,assetCode:asset.code,assetScale:asset.scale}}}];
    const pending:any=await client.grant.request({url:wallet.authServer},{access_token:{access},interact:{start:['redirect'],finish:{method:'redirect',uri:'https://client-b.amma.test/finish',nonce}}} as any);
    const start=await fetch(pending.interact.redirect,{redirect:'manual'});const cookie=start.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    if(process.env.GNAP_DEBUG)out('gnap:debug',{redirect:pending.interact?.redirect,status:start.status,location:start.headers.get('location'),hasCookie:!!cookie});
    const consentUrl=new URL(start.headers.get('location')!,pending.interact.redirect);const iid=consentUrl.searchParams.get('interactId')!,inonce=consentUrl.searchParams.get('nonce')!;
    const view=await api('GET',`/consent/${iid}/${inonce}`,undefined,{user:Number(user)});
    const chosen=await api('POST',`/consent/${iid}/${inonce}`,{hash:view.body.hash,approve:true},{user:Number(user)});
    const fin=await fetch(chosen.body.finishUrl,{redirect:'manual',headers:{cookie}});if(process.env.GNAP_DEBUG)out('gnap:debug2',{view:view.status,chosen:chosen.status,finishUrl:chosen.body?.finishUrl,finStatus:fin.status,finLocation:fin.headers.get('location')});
    const finish=new URL(fin.headers.get('location')!,chosen.body.finishUrl);
    const interactRef=finish.searchParams.get('interact_ref')!;
    await sleep(((pending.continue.wait??1)+1)*1000);
    const grant:any=await client.grant.continue({url:pending.continue.uri,accessToken:pending.continue.access_token.value},{interact_ref:interactRef});
    if(!isFinalizedGrantWithAccessToken(grant))throw new Error('grant not finalized');
    // Recipient: an incoming payment on peer B, and a quote from the customer address.
    const bAddr=await client.walletAddress.get({url:env('PEER_B_CLIENT_ADDRESS')});
    const ig:any=await client.grant.request({url:bAddr.authServer},{access_token:{access:[{type:'incoming-payment',actions:['create','read']}]}} as any);
    const incoming=await client.incomingPayment.create({url:bAddr.resourceServer,accessToken:ig.access_token.value},{walletAddress:bAddr.id,incomingAmount:{value:amount,assetCode:asset.code,assetScale:asset.scale}} as any);
    const qg:any=await client.grant.request({url:wallet.authServer},{access_token:{access:[{type:'quote',actions:['create','read']}]}} as any);
    const quote:any=await client.quote.create({url:wallet.resourceServer,accessToken:qg.access_token.value},{walletAddress:wallet.id,receiver:incoming.id,method:'ilp'} as any);
    const balanceBefore=(await sql`SELECT balance::text FROM payment_accounts WHERE kind='customer' AND owner_id=${Number(user)}`)[0].balance;
    const op=await client.outgoingPayment.create({url:wallet.resourceServer,accessToken:grant.access_token.value},{walletAddress:wallet.id,quoteId:quote.id} as any);
    const opId=new URL(op.id).pathname.split('/').pop()!;const end=Date.now()+120_000;let ledger:any[]=[];
    while(Date.now()<end){ledger=await sql`SELECT reference,amount::text FROM payment_ledger WHERE reference LIKE ${'outgoing:'+opId+'%'} ORDER BY created_at`;
      if(ledger.some(r=>r.reference.endsWith(':spent')))break;await sleep(3000);}
    const incomingState=await incomingAtB(incoming.id);
    const balanceAfter=(await sql`SELECT balance::text FROM payment_accounts WHERE kind='customer' AND owner_id=${Number(user)}`)[0].balance;
    const grants=(await api('GET','/grants',undefined,{user:Number(user)})).body;const stored=grants.find((g:any)=>g.status==='active')??grants[0];
    const revoke=await api('POST',`/grants/${stored.id}/revoke`,{},{user:Number(user)});const revokeAgain=await api('POST',`/grants/${stored.id}/revoke`,{},{user:Number(user)});
    let afterRevoke:string;try{await client.outgoingPayment.create({url:wallet.resourceServer,accessToken:grant.access_token.value},{walletAddress:wallet.id,quoteId:quote.id} as any);afterRevoke='created (UNEXPECTED)';}
    catch(e:any){afterRevoke=`${e?.status??''} ${e?.description??e?.message??''}`.trim();}
    out('gnap',{consentView:{status:view.status,client:view.body?.grant?.client,limit},consentChoose:chosen.status,interactRef:!!interactRef,
      outgoing:opId,quoteDebit:quote.debitAmount?.value,receive:quote.receiveAmount?.value,ledger,incomingAtB:incomingState,balanceBefore,balanceAfter,
      grantStatusBeforeRevoke:stored.status,revoke:revoke.status,revokeAgain:revokeAgain.status,newPaymentAfterRevoke:afterRevoke});
    await invariants('after-gnap');
  },
  async stellarSetup([userId='2',userFund='50000000']){
    // Test-only Stellar testnet actors, created with friendbot. Keys stay in /run/stellar (0700 on the host), never printed.
    const S=await import('@stellar/stellar-sdk');const horizon=new S.Horizon.Server('https://horizon-testnet.stellar.org');
    const file='/run/stellar/keys.json';let keys:any;
    try{keys=JSON.parse(fs.readFileSync(file,'utf8'));}catch{keys={issuer:S.Keypair.random().secret(),treasury:S.Keypair.random().secret(),user:S.Keypair.random().secret()};
      fs.writeFileSync(file,JSON.stringify(keys),{mode:0o600});}
    const kp=Object.fromEntries(Object.entries(keys).map(([k,v])=>[k,S.Keypair.fromSecret(v as string)])) as Record<string,import('@stellar/stellar-sdk').Keypair>;
    for(const k of Object.values(kp)){try{await horizon.loadAccount(k.publicKey());}catch{await fetch(`https://friendbot.stellar.org/?addr=${k.publicKey()}`);}}
    const zarc=new S.Asset('ZARC',kp.issuer.publicKey());
    const send=async(src:import('@stellar/stellar-sdk').Keypair,ops:any[])=>{const acct=await horizon.loadAccount(src.publicKey());
      const b=new S.TransactionBuilder(acct,{fee:'1000',networkPassphrase:S.Networks.TESTNET});ops.forEach(o=>b.addOperation(o));const tx=b.setTimeout(60).build();tx.sign(src);return (await horizon.submitTransaction(tx)).hash;};
    const trusts=async(k:import('@stellar/stellar-sdk').Keypair)=>(await horizon.loadAccount(k.publicKey())).balances.some((b:any)=>b.asset_code==='ZARC'&&b.asset_issuer===kp.issuer.publicKey());
    const evidence:any={};
    for(const who of ['treasury','user'])if(!await trusts(kp[who]))evidence[`${who}Trust`]=await send(kp[who],[S.Operation.changeTrust({asset:zarc})]);
    const userBal=(await horizon.loadAccount(kp.user.publicKey())).balances.find((b:any)=>b.asset_code==='ZARC') as any;
    if(Number(userBal.balance)<Number(userFund)/1e7)evidence.fundUser=await send(kp.issuer,[S.Operation.payment({destination:kp.user.publicKey(),asset:zarc,amount:(Number(userFund)/1e7).toFixed(7)})]);
    // A small XLM/ZARC market so the adapter can value the network fee in ZARC.
    const offers=await horizon.offers().forAccount(kp.issuer.publicKey()).call();
    if(!offers.records.length)evidence.market=await send(kp.issuer,[S.Operation.manageSellOffer({selling:zarc,buying:S.Asset.native(),amount:'1000',price:'0.05'})]);
    await sql`INSERT INTO users(id,email,password_hash) VALUES(${Number(userId)},${`ilp-test-${userId}@amma.test`},'!test-only-no-login') ON CONFLICT(id) DO NOTHING`;
    await sql`INSERT INTO user_wallets(chain,user_id,name,public_key,network,is_active) VALUES('stellar',${Number(userId)},'ILP test',${kp.user.publicKey()},'testnet',true) ON CONFLICT DO NOTHING`;
    out('stellarSetup',{issuer:kp.issuer.publicKey(),treasury:kp.treasury.publicKey(),user:kp.user.publicKey(),userId,evidence});
  },
  async stellarPay([amount='2000000',userId='2']){
    // Customer funds a peer-B payment from their own Stellar testnet ZARC, signing locally (here: the test key).
    const S=await import('@stellar/stellar-sdk');const keys=JSON.parse(fs.readFileSync('/run/stellar/keys.json','utf8'));const user=Number(userId);
    await invariants('before-stellarPay');
    const sources=(await api('GET','/sources',undefined,{user})).body;
    // Exclude managed balances so this payment is funded from the customer's own Stellar wallet.
    const excludedSources=(Array.isArray(sources)?sources:[]).filter((s:any)=>s.adapter!=='stellar').map((s:any)=>s.id);
    const inv=await api('POST','/requests/remote',{walletAddress:env('PEER_B_CLIENT_ADDRESS'),asset,amount},{user});
    if(inv.status!==200)throw new Error(`invoice ${inv.status} ${JSON.stringify(inv.body)}`);const invoice=inv.body;
    const q=await api('POST','/quotes',{requestId:invoice.id,excludedSources},{user});if(q.status!==200)throw new Error(`quote ${q.status} ${JSON.stringify(q.body)}`);const quote=q.body;
    const approved=await approve(quote,user);if(approved.status!==200)throw new Error(`approve ${approved.status} ${JSON.stringify(approved.body)}`);
    let e=approved.body;const end=Date.now()+60_000;
    while(Date.now()<end&&!e.legs?.some((l:any)=>l.prepared?.xdr)){await sleep(2000);e=(await api('GET',`/executions/${e.id}`,undefined,{user})).body;}
    const leg=e.legs.find((l:any)=>l.prepared?.xdr);if(!leg)throw new Error(`no prepared Stellar leg: ${JSON.stringify(e.legs?.map((l:any)=>({state:l.state,adapter:l.route?.source?.adapter})))}`);
    const tx=S.TransactionBuilder.fromXDR(leg.prepared.xdr,S.Networks.TESTNET);tx.sign(S.Keypair.fromSecret(keys.user));
    const signed=await api('POST',`/executions/${e.id}/signatures`,{legId:leg.id,signedTransaction:tx.toXDR()},{user});
    const done=await waitExecution(e.id,['paid','recovery','recovered'],240_000,user);
    const receipt=await api('GET',`/executions/${e.id}/receipt`,undefined,{user});
    out('stellarPay',{amount,sources:sources.map?.((s:any)=>({adapter:s.adapter,asset:s.asset?.code,available:s.available,reason:s.reason})),
      quoteAllocations:quote.allocations?.map((a:any)=>({source:a.route?.source?.adapter??a.source?.adapter,receive:a.receive,maxDebit:a.maxDebit})),
      signature:signed.status,stellarTx:leg.prepared.hash,state:done.state,error:done.error,receipt:receipt.body,incomingAtB:await incomingAtB(invoice.incomingPayment)});
    await invariants('after-stellarPay');
  },
  async stellarObserve([id,user='2']){
    // Read-only: run the Stellar adapter's observe() for each unfinished leg and report the real error, if any.
    const S=await import('@stellar/stellar-sdk');const {postgresDatabase}=await import('../src/modules/payments/runtime');
    const {PaymentStore}=await import('../src/modules/payments/store');const {StellarFundingAdapter}=await import('../src/modules/payments/stellar-adapter');
    const conn=postgres(env('DATABASE_URL'),{max:1});const store=new PaymentStore(postgresDatabase(conn));
    const adapter=new StellarFundingAdapter(store,new S.Horizon.Server(process.env.HORIZON_URL??'https://horizon-testnet.stellar.org'),S.Networks.TESTNET,'testnet',env('PAYMENTS_STELLAR_TREASURY'),JSON.parse(env('PAYMENTS_RAFIKI_ASSETS')).map((a:any)=>a.asset));
    const e:any=await store.get(store.db,'execution',id,Number(user));
    for(const leg of e.legs){try{out('stellarObserve',{leg:leg.id,state:leg.state,observation:await adapter.observe(Number(user),leg)});}
      catch(err:any){out('stellarObserve',{leg:leg.id,error:String(err?.message??err),stack:String(err?.stack??'').split('\n').slice(0,4)});}}
    await conn.end({timeout:2});
  },
  async advanceOnce([id,user='2']){
    // One worker step for this execution under the same job lock the worker takes, reporting the real error.
    const {createPaymentRuntime}=await import('../src/modules/payments/runtime');const runtime:any=await createPaymentRuntime();
    try{await runtime.service.store.db.transaction(async(tx:any)=>{
      await tx.query('SELECT id FROM payment_jobs WHERE id=$1 FOR UPDATE',[id]);
      try{const r=await runtime.service.advance(Number(user),id);out('advanceOnce',{state:r.state,legs:r.legs.map((l:any)=>l.state),outgoing:r.outgoing});}
      catch(err:any){out('advanceOnce',{error:String(err?.message??err),code:err?.code,stack:String(err?.stack??'').split('\n').slice(0,6)});}
    });}finally{await runtime.close();}
  },
  async inspect([id,user='1']){
    const e=(await api('GET',`/executions/${id}`,undefined,{user:Number(user)})).body;const opId=e.outgoing?.id;
    const op=opId?(await adminA.call(`query O($id:String!){outgoingPayment(id:$id){id state error stateAttempts sentAmount{value} debitAmount{value} receiveAmount{value} liquidity}}`,{id:opId})).outgoingPayment:null;
    const holds=await sql`SELECT kind,reference,balance::text FROM payment_accounts WHERE kind='reserved' AND balance>0`;
    const inc=e.quote?.invoice?.incomingPayment?await incomingAtB(e.quote.invoice.incomingPayment):null;
    const legs=e.legs?.map((l:any)=>({id:l.id,state:l.state,adapter:l.route?.source?.adapter??l.source?.adapter,receive:l.receive,maxDebit:l.maxDebit,hash:l.prepared?.hash,observation:l.observation,error:l.error}));
    out('inspect',{execution:id,state:e.state,error:e.error,legs,outgoing:op,incomingAtB:inc,holds});
  },
  async recover([id,user='1']){const r=await api('POST',`/executions/${id}/recover`,{},{user:Number(user)});const again=await api('POST',`/executions/${id}/recover`,{},{user:Number(user)});
    out('recover',{first:r.status,firstState:r.body?.state,second:again.status,secondCode:again.body?.error?.code});await invariants('after-recover');},
  async paused([amount='300000']){
    const {quote}=await startPayment(amount).catch(e=>({quote:null,error:String(e)} as any));
    const r=quote?await approve(quote):null;
    const avail=await fetch(base+'/availability').then(r=>r.json());
    out('paused',{availability:avail,approveStatus:r?.status,code:r?.body?.error?.code});
  },
};
const [cmd,...args]=process.argv.slice(2);
(commands[cmd]??(async()=>{throw new Error(`unknown command ${cmd}`);}))(args)
  .catch(e=>{console.log(JSON.stringify({step:cmd,error:String(e?.message??e)}));process.exitCode=1;})
  .finally(()=>sql.end({timeout:2}));
