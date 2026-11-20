import { request } from './api';
import { getNetworkConfig } from './constants';
import { signApprovedPayment } from './xrpl/vault';
import { decryptSecret } from './crypto';
import { useWalletStore } from '../store/wallet';
import * as Stellar from '@stellar/stellar-sdk';
export type PaymentAsset={chain:'stellar'|'xrpl'|'fiat';network:string;code:string;issuer?:string;scale:number};
export type PaymentSource={id:string;asset:PaymentAsset;available:string;adapter:string;walletId?:string;address?:string;reason?:string};
export type PaymentLeg={id:string;receive:string;maxDebit:string;state:string;route:{source:PaymentSource;simulated?:boolean;networkFee?:{asset:PaymentAsset;amount:string}};prepared?:Record<string,any>};
export type PaymentInvoice={id:string;merchant:string;asset:PaymentAsset;amount:string;reference:string;walletAddress?:string;expiresAt:string};
export type PaymentQuote={id:string;hash:string;invoice:PaymentInvoice;allocations:Omit<PaymentLeg,'id'|'state'>[];expiresAt:string;simulated:boolean;cost:string};
export type PaymentExecution={id:string;owner:number;quote:PaymentQuote;state:string;legs:PaymentLeg[];receipt?:Record<string,unknown>;error?:string};
export function formatUnits(value:string,scale:number){const digits=value.padStart(scale+1,'0');if(!scale)return digits;
  const fraction=digits.slice(-scale).replace(/0+$/,'').padEnd(Math.min(2,scale),'0');return `${digits.slice(0,-scale)}.${fraction}`;}
export function parseUnits(value:string,scale:number){const m=/^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);if(!m||(m[2]?.length??0)>scale)throw new Error('Enter a valid amount.');const result=BigInt(m[1]+(m[2]??'').padEnd(scale,'0'));if(result<=0n)throw new Error('Enter an amount above zero.');return result.toString();}
export function requestIdFromLink(value:string):string{
  if(/^[0-9a-f-]{36}$/i.test(value))return value;
  const url=new URL(value,window.location.origin);
  if(url.origin!==window.location.origin)throw new Error('Open a payment link issued by this Amma deployment.');
  const id=url.searchParams.get('request');if(!id||!/^[0-9a-f-]{36}$/i.test(id))throw new Error('This payment link is invalid.');return id;
}
export async function paymentRequest<T>(path:string,body?:unknown,key?:string,signal?:AbortSignal):Promise<T>{
  return request<T>(`/api/v1/payments${path}`,{method:body===undefined?'GET':'POST',signal,headers:{...(key?{'Idempotency-Key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});
}
export async function signFunding(owner:string,execution:PaymentExecution,leg:PaymentLeg,passphrase:string,signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();
  if(String(execution.owner)!==owner||leg.state!=='prepared'||!leg.prepared)throw new Error('Funding is not ready for this account.');
  if(leg.prepared.chain==='xrpl'){
    const intent=leg.prepared.intent;
    if(intent.amountDrops!==leg.maxDebit||intent.reference!==leg.id||intent.network!=='testnet')throw new Error('Funding details changed.');
    return (await signApprovedPayment(owner,intent.source,passphrase,intent,signal)).blob;
  }
  if(leg.prepared.chain!=='stellar')throw new Error('Unsupported signing request.');
  const p=leg.prepared,network=p.network;
  if(network!=='testnet'&&network!=='public')throw new Error('Unsupported Stellar network.');
  if(leg.route.source.asset.network!==network||execution.quote.invoice.asset.network!==network||leg.route.source.address!==p.source)throw new Error('Funding wallet or network changed.');
  const treasury=import.meta.env.VITE_PAYMENTS_STELLAR_TREASURY;
  if(!treasury||p.treasury!==treasury)throw new Error('Payment treasury is not verified in this application.');
  const tx=Stellar.TransactionBuilder.fromXDR(p.xdr,getNetworkConfig(network).networkPassphrase);
  if(!(tx instanceof Stellar.Transaction)||tx.operations.length!==1||tx.source!==p.source||BigInt(tx.fee)>1000n)throw new Error('Unexpected funding transaction.');
  const op=tx.operations[0];
  if(op.type!=='pathPaymentStrictReceive'||(op.source&&op.source!==p.source)||op.destination!==treasury||parseUnits(op.sendMax,7)!==leg.maxDebit||parseUnits(op.destAmount,7)!==leg.receive)throw new Error('Funding amount or destination changed.');
  const matches=(asset:Stellar.Asset,expected:PaymentAsset)=>asset.code===expected.code&&(asset.issuer??'')===(expected.issuer??'');
  if(!matches(op.sendAsset,leg.route.source.asset)||!matches(op.destAsset,execution.quote.invoice.asset))throw new Error('Funding asset changed.');
  const account=useWalletStore.getState().accounts.find(a=>a.publicKey===p.source);
  if(!account?.encryptedSecret)throw new Error('Restore this Stellar wallet on this device before paying.');
  const secret=await decryptSecret(account.encryptedSecret,passphrase);signal.throwIfAborted();
  const key=Stellar.Keypair.fromSecret(secret);if(key.publicKey()!==p.source)throw new Error('Wallet key does not match.');
  tx.sign(key);return tx.toXDR();
}
