import 'dotenv/config';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import fs from 'node:fs/promises';
import {RafikiAdmin} from './rafiki';
import {requireThat} from './domain';
/** Explicit test-only provisioning. No customer funds or live assets are minted. */
async function main(){
  requireThat(process.argv.includes('--test-only')&&process.env.NODE_ENV!=='production','TEST_ONLY_COMMAND');
  const sides=['A','B'];const configured:any[]=[];
  for(const side of sides){
    const env=(name:string)=>{const value=process.env[`PEER_${side}_${name}`];requireThat(value,`MISSING_PEER_${side}_${name}`);return value;};
    const admin=new RafikiAdmin(env('ADMIN_URL'),env('TENANT_ID'),env('ADMIN_SECRET'));
    const asset=await admin.call(`mutation Asset($input:CreateAssetInput!){createAsset(input:$input){asset{id}}}`,{input:{code:'ZARC',scale:7,idempotencyKey:`amma-test-${side}-zarc`}});
    const assetId=asset.createAsset.asset.id;
    const created=await admin.call(`mutation Address($input:CreateWalletAddressInput!){createWalletAddress(input:$input){walletAddress{id address}}}`,
      {input:{assetId,address:env('CLIENT_ADDRESS'),publicName:`Amma test ${side}`,idempotencyKey:`amma-test-${side}-address`}});
    const wallet=created.createWalletAddress.walletAddress;
    const pem=await fs.readFile(env('PRIVATE_KEY_FILE'),'utf8'),jwk=createPublicKey(createPrivateKey(pem)).export({format:'jwk'});
    await admin.call(`mutation Key($input:CreateWalletAddressKeyInput!){createWalletAddressKey(input:$input){walletAddressKey{id}}}`,
      {input:{walletAddressId:wallet.id,jwk:{kty:jwk.kty,crv:jwk.crv,x:jwk.x,alg:'EdDSA',kid:env('KEY_ID')},idempotencyKey:`amma-test-${side}-key`}});
    configured.push({side,admin,assetId,senderId:wallet.id,senderUrl:wallet.address});
  }
  for(let i=0;i<2;i++){
    const here=configured[i],there=configured[1-i],token=process.env.PEERING_TEST_TOKEN;
    requireThat(token&&token.length>=32,'PEERING_TEST_TOKEN_REQUIRED');
    await here.admin.call(`mutation Peer($input:CreatePeerInput!){createPeer(input:$input){peer{id}}}`,{input:{assetId:here.assetId,
      staticIlpAddress:`test.amma.${there.side.toLowerCase()}`,http:{incoming:{authTokens:[token]},outgoing:{authToken:token,endpoint:`http://peer-${there.side.toLowerCase()}:3002`}},
      name:`Amma test ${there.side}`,initialLiquidity:'1000000000000',idempotencyKey:`amma-test-${here.side}-peer`,routes:[`test.amma.${there.side.toLowerCase()}`]}});
  }
  console.log(JSON.stringify(configured.map(({side,assetId,senderId,senderUrl})=>({side,assetId,senderId,senderUrl})),null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Provisioning failed');process.exitCode=1;});
