// @vitest-environment node
// Crypto/IndexedDB library test: jsdom's realm breaks Uint8Array identity checks in @noble and Stellar SDKs.
import {beforeEach,describe,it,expect,vi} from 'vitest';
import * as Stellar from '@stellar/stellar-sdk';
const state=vi.hoisted(()=>({source:'',secret:'',decrypt:vi.fn()}));
vi.mock('./api',()=>({request:vi.fn()}));
vi.mock('./xrpl/vault',()=>({signApprovedPayment:vi.fn()}));
vi.mock('./crypto',()=>({decryptSecret:state.decrypt}));
vi.mock('../store/wallet',()=>({useWalletStore:{getState:()=>({accounts:[{publicKey:state.source,encryptedSecret:'fixture-ciphertext'}]})}}));
import {formatUnits,parseUnits,requestIdFromLink,signFunding,type PaymentExecution,type PaymentLeg} from './payments';
import {paymentReturnPath} from './payment-return';
describe('payment review and local signing boundaries',()=>{
  const source=Stellar.Keypair.random(),treasury=Stellar.Keypair.random();
  beforeEach(()=>{
    state.source=source.publicKey();state.secret=source.secret();state.decrypt.mockReset().mockResolvedValue(state.secret);
    vi.stubEnv('VITE_PAYMENTS_STELLAR_TREASURY',treasury.publicKey());vi.stubGlobal('window',{location:{origin:'https://amma.example'}});
  });
  function fixtures(amount='10.0000000',destination=treasury.publicKey()){
    const asset={chain:'stellar' as const,network:'testnet',code:'XLM',scale:7};
    const tx=new Stellar.TransactionBuilder(new Stellar.Account(source.publicKey(),'1'),{fee:'1000',networkPassphrase:Stellar.Networks.TESTNET})
      .addOperation(Stellar.Operation.pathPaymentStrictReceive({sendAsset:Stellar.Asset.native(),sendMax:amount,destination,destAsset:Stellar.Asset.native(),destAmount:'10.0000000',path:[]})).setTimeout(180).build();
    const leg={id:'leg',receive:'100000000',maxDebit:'100000000',state:'prepared',route:{source:{id:'source',address:source.publicKey(),asset,available:'100000000',adapter:'stellar'}},
      prepared:{chain:'stellar',network:'testnet',source:source.publicKey(),treasury:treasury.publicKey(),xdr:tx.toXDR()}} as PaymentLeg;
    const execution={owner:1,quote:{invoice:{asset}}} as PaymentExecution;return {leg,execution};
  }
  it('formats review values without binary rounding or misleading trailing zeros',()=>{
    expect(formatUnits('1000000000',7)).toBe('100.00');expect(formatUnits('1',7)).toBe('0.0000001');
    expect(parseUnits('9007199254740993.1234567',7)).toBe('90071992547409931234567');
  });
  it('rejects untrusted redirects and cross-origin request links',()=>{
    const id='11111111-1111-4111-8111-111111111111';
    expect(paymentReturnPath(`/payments?request=${id}`)).toBe(`/payments?request=${id}`);
    expect(paymentReturnPath('https://evil.example/payments')).toBeNull();expect(paymentReturnPath('/payments?request=x&next=https://evil.example')).toBeNull();
    expect(paymentReturnPath('/payments/consent?interactId=abc&nonce=def&clientName=Shop&clientUri=https%3A%2F%2Fshop.example')).not.toBeNull();
    expect(()=>requestIdFromLink(`https://evil.example/payments?request=${id}`)).toThrow();
  });
  it('signs the exact approved Stellar funding locally',async()=>{
    const {execution,leg}=fixtures(),blob=await signFunding('1',execution,leg,'fixture-passphrase',new AbortController().signal);
    const signed=Stellar.TransactionBuilder.fromXDR(blob,Stellar.Networks.TESTNET) as Stellar.Transaction;
    expect(signed.signatures).toHaveLength(1);expect(source.verify(signed.hash(),signed.signatures[0].signature())).toBe(true);
  });
  it('does not decrypt keys for changed debits or destinations',async()=>{
    for(const changed of [fixtures('11.0000000'),fixtures('10.0000000',Stellar.Keypair.random().publicKey())]){
      await expect(signFunding('1',changed.execution,changed.leg,'fixture-passphrase',new AbortController().signal)).rejects.toThrow('changed');
    }expect(state.decrypt).not.toHaveBeenCalled();
  });
  it('stops signing after owner change or session cancellation',async()=>{
    const {execution,leg}=fixtures();await expect(signFunding('2',execution,leg,'fixture',new AbortController().signal)).rejects.toThrow();
    const controller=new AbortController();controller.abort();await expect(signFunding('1',execution,leg,'fixture',controller.signal)).rejects.toThrow();expect(state.decrypt).not.toHaveBeenCalled();
  });
  it('rejects a prepared transaction on another network before unlocking',async()=>{
    const {execution,leg}=fixtures();leg.prepared!.network='public';
    await expect(signFunding('1',execution,leg,'fixture',new AbortController().signal)).rejects.toThrow('network changed');
    expect(state.decrypt).not.toHaveBeenCalled();
  });
});
