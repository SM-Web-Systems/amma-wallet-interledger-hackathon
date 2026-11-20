import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import {PaymentStore,type Database,type Session} from './store';
import {ProviderEvents} from './provider-events';
import {assetKey,type Asset} from './domain';
import type {RafikiAdmin} from './rafiki';

describe('provider webhook financial reconciliation',()=>{
  const asset:Asset={chain:'stellar',network:'testnet',code:'ZARC',issuer:'GTESTISSUER',scale:7};
  let pg:PGlite,store:PaymentStore,events:ProviderEvents,account:string,paused:boolean;
  let payment:any;
  const call=vi.fn(),fund=vi.fn();
  beforeEach(async()=>{
    pg=new PGlite();
    const session=(client:any):Session=>({query:async(text,params=[])=> (await client.query(text,params)).rows});
    const db:Database={...session(pg),transaction:async fn=>pg.transaction(tx=>fn(session(tx)))};
    await pg.exec(await fs.readFile(new URL('../../db/migrations/payments-v1.sql',import.meta.url),'utf8'));
    store=new PaymentStore(db);paused=false;call.mockReset();fund.mockReset().mockResolvedValue(undefined);
    call.mockImplementation(async(query:string)=>{
      if(query.includes('createIncomingPaymentWithdrawal'))return {createIncomingPaymentWithdrawal:{success:true}};
      if(query.includes('createOutgoingPaymentWithdrawal'))return {createOutgoingPaymentWithdrawal:{success:true}};
      if(query.includes('cancelOutgoingPayment'))return {cancelOutgoingPayment:{payment:{id:'outgoing'}}};
      if(query.includes('query Incoming'))return {incomingPayment:payment};
      return {outgoingPayment:payment};
    });
    events=new ProviderEvents(store,{call,fund} as unknown as RafikiAdmin,()=>!paused);
    await db.transaction(async tx=>{
      account=await store.account(tx,1,asset);
      await store.transfer(tx,await store.account(tx,0,asset,'clearing'),account,asset,'100','seed');
      await tx.query('INSERT INTO payment_wallet_addresses(url,owner_id,account_id,rafiki_id,asset_key) VALUES($1,1,$2,$3,$4)',
        ['https://amma.example/one',account,'wallet-one',assetKey(asset)]);
    });
  });
  afterEach(async()=>{await pg.close();});
  const event=(type:string,id:string)=>({type,data:{id:id==='outgoing'?'22222222-2222-4222-8222-222222222222':id}});
  const amount=(value:string)=>({value,assetCode:'ZARC',assetScale:7});
  it('credits a finalized incoming payment once across distinct duplicate events',async()=>{
    payment={id:'incoming',walletAddressId:'wallet-one',state:'COMPLETED',receivedAmount:amount('25')};
    await events.handle(event('incoming_payment.completed','incoming'));
    await events.handle(event('incoming_payment.completed','incoming'));
    expect((await store.balances(1))[0].available).toBe('125');
    expect(await store.db.query("SELECT id FROM payment_ledger WHERE reference='incoming:incoming'")).toHaveLength(1);
  });
  it('never credits from a webhook body or before withdrawal confirmation',async()=>{
    payment={id:'incoming',walletAddressId:'wallet-one',state:'COMPLETED',receivedAmount:amount('25')};
    call.mockResolvedValueOnce({incomingPayment:payment}).mockResolvedValueOnce({createIncomingPaymentWithdrawal:{success:false}});
    await expect(events.handle({...event('incoming_payment.completed','incoming'),data:{id:'incoming',receivedAmount:amount('999')}})).rejects.toThrow('WITHDRAWAL_UNCONFIRMED');
    expect((await store.balances(1))[0].available).toBe('100');
  });
  it('reserves an outgoing once, charges actual consumption and returns unused liquidity once',async()=>{
    payment={id:'outgoing',walletAddressId:'wallet-one',state:'FUNDING',debitAmount:amount('70')};
    await events.handle(event('outgoing_payment.created','outgoing'));
    await events.handle(event('outgoing_payment.created','outgoing'));
    expect((await store.balances(1))[0].available).toBe('30');
    payment={...payment,state:'COMPLETED',liquidity:'5'};
    await events.handle(event('outgoing_payment.completed','outgoing'));
    // The second authoritative read has no liquidity after the first withdrawal;
    // the durable pre-withdrawal snapshot still drives the same ledger posting.
    payment.liquidity='0';await events.handle(event('outgoing_payment.completed','outgoing'));
    expect((await store.balances(1))[0].available).toBe('35');
  });
  it('pauses new funding while still reconciling received funds',async()=>{
    paused=true;payment={id:'outgoing',walletAddressId:'wallet-one',state:'FUNDING',debitAmount:amount('20')};
    await expect(events.handle(event('outgoing_payment.created','outgoing'))).rejects.toThrow('PAYMENTS_PAUSED');
    expect(fund).not.toHaveBeenCalled();
    payment={id:'incoming',walletAddressId:'wallet-one',state:'COMPLETED',receivedAmount:amount('5')};
    await events.handle(event('incoming_payment.completed','incoming'));
    expect((await store.balances(1))[0].available).toBe('105');
  });
  it('declines overspending and rejects mismatched authoritative assets',async()=>{
    payment={id:'outgoing',walletAddressId:'wallet-one',state:'FUNDING',debitAmount:amount('101')};
    await events.handle(event('outgoing_payment.created','outgoing'));
    expect(fund).not.toHaveBeenCalled();expect(call.mock.calls.some(([query])=>query.includes('cancelOutgoingPayment'))).toBe(true);
    payment={id:'incoming',walletAddressId:'wallet-one',state:'COMPLETED',receivedAmount:{...amount('5'),assetCode:'USDC'}};
    await expect(events.handle(event('incoming_payment.completed','incoming'))).rejects.toThrow('INCOMING_ASSET_MISMATCH');
    expect((await store.balances(1))[0].available).toBe('100');
  });
  it('credits only what actually arrived when an incoming payment expires part-paid',async()=>{
    payment={id:'incoming',walletAddressId:'wallet-one',state:'EXPIRED',receivedAmount:amount('7')};
    await events.handle(event('incoming_payment.expired','incoming'));
    expect((await store.balances(1))[0].available).toBe('107');
  });
  it('charges only the delivered part when an outgoing payment fails after partial delivery',async()=>{
    payment={id:'outgoing',walletAddressId:'wallet-one',state:'FUNDING',debitAmount:amount('70')};
    await events.handle(event('outgoing_payment.created','outgoing'));
    payment={...payment,state:'FAILED',liquidity:'40'};
    await events.handle(event('outgoing_payment.failed','outgoing'));
    const [balance]=await store.balances(1);
    expect(balance.available).toBe('70');
    expect(await store.db.query("SELECT amount FROM payment_ledger WHERE reference LIKE 'outgoing:%:spent'")).toEqual([{amount:'30'}]);
  });
  it('keeps one reservation and retries funding when provider liquidity is unavailable',async()=>{
    payment={id:'outgoing',walletAddressId:'wallet-one',state:'FUNDING',debitAmount:amount('70')};
    fund.mockRejectedValueOnce(new Error('RAFIKI_ADMIN_UNAVAILABLE'));
    await expect(events.handle(event('outgoing_payment.created','outgoing'))).rejects.toThrow('RAFIKI_ADMIN_UNAVAILABLE');
    expect((await store.balances(1))[0].available).toBe('30');
    await events.handle(event('outgoing_payment.created','outgoing'));
    expect((await store.balances(1))[0].available).toBe('30');
    expect(fund).toHaveBeenCalledTimes(2);
    expect(fund.mock.calls[0]).toEqual(fund.mock.calls[1]); // Same idempotency key on the retry.
  });
  describe('catch-up scan for lost webhooks',()=>{
    const now=new Date('2026-11-09T00:00:00Z'),hour=3600_000;
    const at=(hoursAgo:number)=>new Date(now.getTime()-hoursAgo*hour).toISOString();
    const IN=['11111111-1111-4111-8111-000000000001','11111111-1111-4111-8111-000000000002','11111111-1111-4111-8111-000000000003','11111111-1111-4111-8111-000000000004'];
    const OUT='22222222-2222-4222-8222-000000000001';
    let incomingPages:any[][],outgoingPages:any[][];
    beforeEach(()=>{
      incomingPages=[];outgoingPages=[];
      call.mockImplementation(async(query:string,variables:any)=>{
        if(query.includes('query CatchUpIncoming')){
          const page=variables.after?Number(variables.after):0,edges=(incomingPages[page]??[]).map(node=>({node}));
          return {walletAddress:{incomingPayments:{edges,pageInfo:{hasNextPage:page+1<incomingPages.length,endCursor:String(page+1)}}}};
        }
        if(query.includes('query CatchUpOutgoing')){
          const page=variables.after?Number(variables.after):0,edges=(outgoingPages[page]??[]).map(node=>({node}));
          return {outgoingPayments:{edges,pageInfo:{hasNextPage:page+1<outgoingPages.length,endCursor:String(page+1)}}};
        }
        throw new Error('unexpected Admin call during catch-up: '+query.slice(0,40));
      });
    });
    const jobs=async()=>(await store.db.query('SELECT id,kind,owner_id FROM payment_jobs ORDER BY id')).map((j:any)=>`${j.kind}:${j.id}:${j.owner_id}`);
    it('queues finished incoming payments that no webhook delivered, once',async()=>{
      incomingPages=[[{id:IN[0],state:'COMPLETED',createdAt:at(1),receivedAmount:{value:'40'}}]];
      await events.catchUp(now);await events.catchUp(now);
      expect(await jobs()).toEqual([`rafiki-incoming:${IN[0]}:1`]);
      expect((await store.db.query('SELECT body FROM payment_jobs'))[0].body).toEqual({id:IN[0]});
      expect((await store.balances(1))[0].available).toBe('100'); // Queued only: the worker reads Rafiki before crediting.
    });
    it('skips pending, empty, already credited and out-of-window incoming payments, and follows pages',async()=>{
      await store.db.transaction(async tx=>store.transfer(tx,await store.account(tx,0,asset,'clearing'),account,asset,'9',`incoming:${IN[1]}`));
      incomingPages=[
        [{id:IN[0],state:'PENDING',createdAt:at(1),receivedAmount:{value:'0'}},{id:IN[1],state:'COMPLETED',createdAt:at(2),receivedAmount:{value:'9'}}],
        [{id:IN[2],state:'EXPIRED',createdAt:at(3),receivedAmount:{value:'0'}},{id:IN[3],state:'EXPIRED',createdAt:at(4),receivedAmount:{value:'7'}}],
        [{id:'11111111-1111-4111-8111-0000000000ff',state:'COMPLETED',createdAt:at(24*30),receivedAmount:{value:'1'}}],
      ];
      await events.catchUp(now,7*24*hour);
      expect(await jobs()).toEqual([`rafiki-incoming:${IN[3]}:1`]);
      expect(call.mock.calls.filter(([q])=>q.includes('query CatchUpIncoming'))).toHaveLength(3);
    });
    it('queues unfunded outgoing payments for funding, only while submissions are allowed',async()=>{
      outgoingPages=[[{id:OUT,walletAddressId:'wallet-one',state:'FUNDING',createdAt:at(1)}]];
      paused=true;await events.catchUp(now);
      expect(await jobs()).toEqual([]);
      expect(call.mock.calls.some(([q])=>q.includes('query CatchUpOutgoing'))).toBe(false);
      paused=false;await events.catchUp(now);
      expect(await jobs()).toEqual([`rafiki-outgoing:${OUT}:1`]);
      const filter=call.mock.calls.find(([q])=>q.includes('query CatchUpOutgoing'))![1].filter;
      expect(filter).toEqual({walletAddressId:{in:['wallet-one']},state:{in:['FUNDING']}});
      expect(fund).not.toHaveBeenCalled();
    });
  });
});
