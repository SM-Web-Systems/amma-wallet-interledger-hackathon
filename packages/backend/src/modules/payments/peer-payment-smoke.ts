import 'dotenv/config';
import fs from 'node:fs/promises';
import {createAuthenticatedClient,isFinalizedGrantWithAccessToken} from '@interledger/open-payments';
import {RafikiAdmin} from './rafiki';
import {requireThat} from './domain';
/**
 * Explicit test-only smoke check for the two isolated Rafiki peers created by
 * provision-peers.ts. Sends one small test-ZARC payment from peer A to peer B the
 * same way RafikiRail does (Open Payments incoming payment and quote, then an
 * admin-created and admin-funded outgoing payment). It never touches the Amma
 * customer ledger, so PAYMENTS_PAUSED stays in force for customer funds.
 */
async function main(){
  requireThat(process.argv.includes('--test-only')&&process.env.NODE_ENV!=='production','TEST_ONLY_COMMAND');
  const env=(name:string)=>{const value=process.env[name];requireThat(value,`MISSING_${name}`);return value;};
  const amount=process.env.SMOKE_RECEIVE_UNITS??'1234567';requireThat(/^[1-9]\d{0,11}$/.test(amount),'INVALID_SMOKE_AMOUNT');
  const adminA=new RafikiAdmin(env('PEER_A_ADMIN_URL'),env('PEER_A_TENANT_ID'),env('PEER_A_ADMIN_SECRET'));
  const adminB=new RafikiAdmin(env('PEER_B_ADMIN_URL'),env('PEER_B_TENANT_ID'),env('PEER_B_ADMIN_SECRET'));
  const sender=env('PEER_A_CLIENT_ADDRESS'),receiver=env('PEER_B_CLIENT_ADDRESS');
  const client=await createAuthenticatedClient({walletAddressUrl:sender,keyId:env('PEER_A_KEY_ID'),
    privateKey:await fs.readFile(env('PEER_A_PRIVATE_KEY_FILE'),'utf8'),requestTimeoutMs:10_000,logLevel:'silent'});
  const [from,to]=await Promise.all([client.walletAddress.get({url:sender}),client.walletAddress.get({url:receiver})]);
  requireThat(from.assetCode==='ZARC'&&to.assetCode==='ZARC','UNEXPECTED_TEST_ASSET');
  const incomingGrant=await client.grant.request({url:to.authServer},{access_token:{access:[{type:'incoming-payment',actions:['create','read'],identifier:to.id}]}});
  requireThat(isFinalizedGrantWithAccessToken(incomingGrant),'RECIPIENT_GRANT_REQUIRES_INTERACTION');
  const incoming=await client.incomingPayment.create({url:to.resourceServer,accessToken:incomingGrant.access_token.value},
    {walletAddress:to.id,incomingAmount:{value:amount,assetCode:to.assetCode,assetScale:to.assetScale},expiresAt:new Date(Date.now()+10*60_000).toISOString(),metadata:{purpose:'amma-test-smoke'}});
  const quoteGrant=await client.grant.request({url:from.authServer},{access_token:{access:[{type:'quote',actions:['create','read']}]}});
  requireThat(isFinalizedGrantWithAccessToken(quoteGrant),'QUOTE_GRANT_REQUIRES_INTERACTION');
  const quote=await client.quote.create({url:from.resourceServer,accessToken:quoteGrant.access_token.value},{walletAddress:from.id,receiver:incoming.id,method:'ilp'});
  requireThat(quote.receiveAmount.value===amount,'QUOTE_RECEIVE_MISMATCH');
  const senderId=(await adminA.call<any>(`query W($url:String!){walletAddressByUrl(url:$url){id}}`,{url:sender})).walletAddressByUrl.id;
  const key=`amma-test-smoke-${Date.now()}`,quoteId=new URL(quote.id).pathname.split('/').pop()!;
  const created=await adminA.call<any>(`mutation O($input:CreateOutgoingPaymentInput!){createOutgoingPayment(input:$input){payment{id state}}}`,
    {input:{walletAddressId:senderId,quoteId,metadata:{purpose:'amma-test-smoke'},idempotencyKey:key}});
  const outgoingId=created.createOutgoingPayment.payment.id;
  await adminA.fund(outgoingId,`${key}:fund`);
  let payment:any;
  for(let i=0;i<30;i++){
    payment=(await adminA.call<any>(`query P($id:String!){outgoingPayment(id:$id){id state error sentAmount{value} debitAmount{value} receiveAmount{value}}}`,{id:outgoingId})).outgoingPayment;
    if(['COMPLETED','FAILED','CANCELLED'].includes(payment.state))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const incomingId=new URL(incoming.id).pathname.split('/').pop()!;
  const received=(await adminB.call<any>(`query I($id:String!){incomingPayment(id:$id){id state receivedAmount{value assetCode assetScale}}}`,{id:incomingId})).incomingPayment;
  console.log(JSON.stringify({incomingPayment:incoming.id,quote:{id:quote.id,debit:quote.debitAmount,receive:quote.receiveAmount},
    outgoingPayment:payment,incomingOnB:received},null,2));
  requireThat(payment.state==='COMPLETED'&&received.receivedAmount.value===amount,'SMOKE_PAYMENT_NOT_COMPLETED');
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Smoke payment failed');process.exitCode=1;});
