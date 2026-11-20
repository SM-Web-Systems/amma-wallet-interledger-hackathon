import {beforeEach,describe,expect,it,vi} from 'vitest';
import * as Stellar from '@stellar/stellar-sdk';
import {StellarFundingAdapter} from './stellar-adapter';
import {PaymentStore} from './store';
import {assetKey,canonical,newId,type Execution,type Leg} from './domain';

describe('Stellar funding signing and confirmation',()=>{
  const source=Stellar.Keypair.random(),treasury=Stellar.Keypair.random();
  const asset={chain:'stellar' as const,network:'testnet',code:'XLM',scale:7};
  let adapter:StellarFundingAdapter,leg:Leg,execution:Execution;
  const records=new Map<string,any>(),submit=vi.fn(),lookup=vi.fn(),latest=vi.fn();
  beforeEach(()=>{
    records.clear();submit.mockReset();lookup.mockReset();latest.mockReset();
    const db:any={query:async(query:string,params:any[])=>{
      if(query.includes('user_wallets'))return [{public_key:source.publicKey()}];
      const row=records.get(params[0]);return row?[{body:row}]:[];
    }};
    db.transaction=async(fn:any)=>fn(db);
    const store=new PaymentStore(db);
    vi.spyOn(store,'put').mockImplementation(async(_tx,_kind,id,_owner,body)=>{records.set(id,body);});
    vi.spyOn(store,'get').mockImplementation(async(_tx,_kind,id)=>{const row=records.get(id);if(!row)throw new Error('not found');return row;});
    const server={loadAccount:async()=>new Stellar.Account(source.publicKey(),'5'),submitTransaction:submit,
      transactions:()=>({transaction:()=>({call:lookup})}),
      ledgers:()=>({order:()=>({limit:()=>({call:latest})})})} as unknown as Stellar.Horizon.Server;
    adapter=new StellarFundingAdapter(store,server,Stellar.Networks.TESTNET,'testnet',treasury.publicKey(),[asset]);
    leg={id:newId(),state:'planned',receive:'10000000',maxDebit:'10000000',route:{id:'route',source:{id:'source',walletId:'1',address:source.publicKey(),asset,adapter:'stellar',available:'20000000'},capacity:'20000000',numerator:'1',denominator:'1',fee:'0',valuationNumerator:'1',valuationDenominator:'1',expiresAt:new Date(Date.now()+30_000).toISOString(),evidence:{}}};
    execution={id:newId(),owner:1,quote:{invoice:{asset}}} as Execution;
  });
  it('persists signed evidence before a timeout and confirms only authoritative ledger success',async()=>{
    leg.prepared=await adapter.prepare(1,execution,leg);
    const tx=Stellar.TransactionBuilder.fromXDR(leg.prepared!.xdr as string,Stellar.Networks.TESTNET) as Stellar.Transaction;tx.sign(source);
    submit.mockImplementation(async()=>{expect(records.get(leg.id).signed).toBe(tx.toXDR());throw new Error('timeout');});
    await adapter.submit(1,leg,tx.toXDR());
    lookup.mockRejectedValueOnce(new Error('not indexed'));expect((await adapter.observe(1,leg)).state).toBe('unknown');
    lookup.mockResolvedValue({successful:true,hash:tx.hash().toString('hex'),ledger:123});
    expect(await adapter.observe(1,leg)).toMatchObject({state:'confirmed',received:leg.receive,assetKey:assetKey(asset)});
    lookup.mockResolvedValue({successful:false,hash:tx.hash().toString('hex')});expect((await adapter.observe(1,leg)).state).toBe('failed');
  });
  it('records the ledger number, not the SDK link function, so the evidence can be stored',async()=>{
    // Horizon records from @stellar/stellar-sdk carry the ledger number in ledger_attr;
    // `ledger` is a function that fetches the ledger. Seen on Stellar Testnet 2026-11-09.
    leg.prepared=await adapter.prepare(1,execution,leg);
    const tx=Stellar.TransactionBuilder.fromXDR(leg.prepared!.xdr as string,Stellar.Networks.TESTNET) as Stellar.Transaction;tx.sign(source);
    submit.mockResolvedValue({});await adapter.submit(1,leg,tx.toXDR());
    lookup.mockResolvedValue({successful:true,hash:tx.hash().toString('hex'),ledger_attr:123,ledger:async()=>({sequence:123})});
    const observation=await adapter.observe(1,leg);
    expect(observation.evidence).toEqual({ledger:123});
    expect(()=>JSON.parse(canonical(observation))).not.toThrow();
  });
  it('rejects a signed transaction with a different destination or signer',async()=>{
    leg.prepared=await adapter.prepare(1,execution,leg);
    const wrong=new Stellar.TransactionBuilder(new Stellar.Account(source.publicKey(),'5'),{fee:'1000',networkPassphrase:Stellar.Networks.TESTNET})
      .addOperation(Stellar.Operation.payment({destination:source.publicKey(),asset:Stellar.Asset.native(),amount:'1'})).setTimeout(180).build();wrong.sign(source);
    await expect(adapter.submit(1,leg,wrong.toXDR())).rejects.toThrow('SIGNED_TRANSACTION_MISMATCH');
    const tx=Stellar.TransactionBuilder.fromXDR(leg.prepared!.xdr as string,Stellar.Networks.TESTNET) as Stellar.Transaction;tx.sign(treasury);
    await expect(adapter.submit(1,leg,tx.toXDR())).rejects.toThrow('INVALID_SIGNATURE');expect(submit).not.toHaveBeenCalled();
  });
  const notFound=()=>Object.assign(new Error('Not Found'),{response:{status:404}});
  const signedExpired=async()=>{
    leg.prepared=await adapter.prepare(1,execution,leg);
    const tx=Stellar.TransactionBuilder.fromXDR(leg.prepared!.xdr as string,Stellar.Networks.TESTNET) as Stellar.Transaction;tx.sign(source);
    submit.mockRejectedValue(new Error('timeout'));await adapter.submit(1,leg,tx.toXDR());
    return Number(tx.timeBounds!.maxTime)*1000;
  };
  it('fails a signed leg only after a closed ledger proves its time bounds expired without inclusion',async()=>{
    const maxTime=await signedExpired();
    lookup.mockRejectedValue(notFound());
    // Ledger close still inside the time bounds: the transaction may yet apply.
    latest.mockResolvedValue({records:[{closed_at:new Date(maxTime-1000).toISOString()}]});
    expect((await adapter.observe(1,leg)).state).toBe('unknown');
    // A closed ledger past maxTime and an authoritative 404 prove non-inclusion.
    latest.mockResolvedValue({records:[{closed_at:new Date(maxTime+1000).toISOString()}]});
    expect(await adapter.observe(1,leg)).toMatchObject({state:'failed',evidence:{code:'TIME_BOUNDS_EXPIRED_NOT_INCLUDED'}});
  });
  it('keeps an expired leg unknown when Horizon errors are not an authoritative 404',async()=>{
    const maxTime=await signedExpired();
    lookup.mockRejectedValue(new Error('socket hang up'));
    latest.mockResolvedValue({records:[{closed_at:new Date(maxTime+60_000).toISOString()}]});
    expect((await adapter.observe(1,leg)).state).toBe('unknown');
  });
});

describe('Stellar funding sources',()=>{
  const asset={chain:'stellar' as const,network:'testnet',code:'XLM',scale:7};
  const funded=Stellar.Keypair.random().publicKey(),unfunded=Stellar.Keypair.random().publicKey();
  const notFound=()=>Object.assign(new Error('Not Found'),{response:{status:404}});
  const build=(loadAccount:(key:string)=>Promise<unknown>)=>{
    const db:any={query:async()=>[{id:'1',public_key:unfunded},{id:'2',public_key:funded}]};
    const server={loadAccount,ledgers:()=>({order:()=>({limit:()=>({call:async()=>({records:[{base_reserve_in_stroops:5000000}]})})})})} as unknown as Stellar.Horizon.Server;
    return new StellarFundingAdapter(new PaymentStore(db),server,Stellar.Networks.TESTNET,'testnet',Stellar.Keypair.random().publicKey(),[asset]);
  };
  const account={subentry_count:0,balances:[{asset_type:'native',balance:'100.0000000',selling_liabilities:'0.0000000'}]};
  it('skips an unfunded wallet instead of hiding the funded ones',async()=>{
    const sources=await build(async key=>{if(key===unfunded)throw notFound();return account;}).sources(1);
    // 100 XLM less the 1 XLM base reserve (2 x 0.5) and the 1000-stroop fee bound.
    expect(sources).toEqual([expect.objectContaining({walletId:'2',address:funded,available:'989999000'})]);
  });
  it('still fails the whole lookup when Horizon is unavailable, so nothing is fabricated',async()=>{
    await expect(build(async()=>{throw Object.assign(new Error('Bad Gateway'),{response:{status:502}});}).sources(1)).rejects.toThrow('Bad Gateway');
  });
});
