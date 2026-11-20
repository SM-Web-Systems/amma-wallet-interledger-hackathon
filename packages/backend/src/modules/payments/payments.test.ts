import { beforeEach,afterAll,describe,it,expect,vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import { PaymentStore,type Database,type Session } from './store';
import { PaymentService } from './service';
import { ManagedAdapter,FixtureAdapter } from './adapters';
import { assetKey,decimal,display,newId,canonical,type Asset,type Invoice,type PaymentRail,type Route,type Source } from './domain';
import { planFunding } from './planner';

const zar:Asset={chain:'stellar',network:'testnet',code:'ZARC',issuer:'GTESTISSUER',scale:7};
const usd:Asset={chain:'stellar',network:'testnet',code:'USDC',issuer:'GUSDCISSUER',scale:7};
const xrp:Asset={chain:'xrpl',network:'testnet',code:'XRP',scale:6};
const expiry=()=>new Date(Date.now()+60_000).toISOString();
function route(id:string,available:string,capacity=available,fee='0',n='1',d='1'):Route {
  return {id,source:{id,asset:zar,available,adapter:'fixture'},capacity,fee,numerator:n,denominator:d,valuationNumerator:'1',valuationDenominator:'1',expiresAt:expiry(),evidence:{}};
}
describe('exact funding planner',()=>{
  it('preserves amounts above Number.MAX_SAFE_INTEGER',()=>{
    expect(planFunding('9007199254740993',[route('a','9007199254740993')]).allocations[0].maxDebit).toBe('9007199254740993');
    expect(display(decimal('0.0000001',7),7)).toBe('0.0000001');
  });
  it('combines balances when neither source covers the invoice',()=>{
    const plan=planFunding('100',[route('a','60'),route('b','45')]);expect(plan.allocations.map(a=>a.receive)).toEqual(['60','40']);
  });
  it('includes fixed fees rather than selecting a superficially cheaper route',()=>{
    const result=planFunding('100',[route('cheap-rate','200','200','40'),route('low-total','200','200','0','11','10')]);
    expect(result.allocations[0].route.id).toBe('low-total');expect(result.allocations[0].maxDebit).toBe('110');
  });
  it('does not count alternate routes as independent balances',()=>{
    const a=route('one','60'),b={...route('two','60'),source:a.source};expect(()=>planFunding('100',[a,b])).toThrow('INSUFFICIENT');
  });
  it('excludes stale, locked and explicitly excluded sources',()=>{
    const stale={...route('stale','100'),expiresAt:'2000-01-01T00:00:00Z'},locked=route('locked','100');locked.source.reason='FROZEN';
    expect(()=>planFunding('100',[stale,locked,route('excluded','100')],['excluded'])).toThrow('INSUFFICIENT');
  });
  it('breaks equal-cost ties deterministically and prefers fewer legs',()=>{
    expect(planFunding('100',[route('a','50'),route('b','50'),route('z','100')]).allocations[0].route.id).toBe('z');
    expect(planFunding('100',[route('b','100'),route('a','100')]).allocations[0].route.id).toBe('a');
  });
  it('rejects scientific notation and excess decimal precision',()=>{
    expect(()=>decimal('1e3',7)).toThrow();expect(()=>decimal('1.00000001',7)).toThrow();
    expect(canonical({z:undefined,a:'1'})).toBe('{"a":"1"}');
  });
});

describe('durable payment ledger and orchestration',()=>{
  let pg:PGlite,store:PaymentStore,service:PaymentService,account:string;
  let outcome:'confirmed'|'pending'|'failed'='confirmed';
  let unused:string|undefined;
  const rail:PaymentRail={quote:async invoice=>({debit:invoice.amount,expiresAt:expiry(),data:{}}),
    prepare:vi.fn(async e=>({id:e.id})),observe:async e=>({state:outcome,reference:e.id,received:e.quote.invoice.amount,assetKey:assetKey(e.quote.invoice.asset),evidence:{unused:unused??(outcome==='failed'?e.quote.receive:'0')}})};
  beforeEach(async()=>{
    if(pg)await pg.close();pg=new PGlite();
    const session=(client:any):Session=>({query:async(text,params=[])=>{const result=await client.query(text,params);return result.rows;}});
    const db:Database={...session(pg),transaction:async fn=>pg.transaction(tx=>fn(session(tx)))};
    await pg.exec(await fs.readFile(new URL('../../db/migrations/payments-v1.sql',import.meta.url),'utf8'));
    store=new PaymentStore(db);service=new PaymentService(store,[new ManagedAdapter(store)],rail,()=>true);outcome='confirmed';unused=undefined;
    await db.transaction(async tx=>{account=await store.account(tx,1,zar);const clearing=await store.account(tx,0,zar,'clearing');await store.transfer(tx,clearing,account,zar,'100','seed');});
  });
  afterAll(async()=>{if(pg)await pg.close();});
  async function approved(amount='70'){
    const invoice=await service.invoice(2,newId(),{merchant:'Spaza',asset:zar,amount,reference:'test'});
    const quote=await service.quote(1,invoice.id,newId());return service.approve(1,quote.id,quote.hash,newId());
  }
  it('reserves before execution, survives a new service instance, and posts payment once',async()=>{
    const execution=await approved();expect((await store.balances(1))[0].available).toBe('30');
    const restarted=new PaymentService(store,[new ManagedAdapter(store)],rail,()=>true);
    expect((await restarted.advance(1,execution.id)).state).toBe('paid');
    expect((await restarted.advance(1,execution.id)).state).toBe('paid');
    const rows=await store.db.query("SELECT * FROM payment_ledger WHERE reference=$1",[`${execution.id}:paid`]);expect(rows).toHaveLength(1);
  });
  it('rejects conflicting idempotency keys and duplicate approval under a new key',async()=>{
    const execution=await approved(),key=newId();
    await service.invoice(1,key,{merchant:'Spaza',asset:zar,amount:'10',reference:'test'});
    await expect(service.invoice(1,key,{merchant:'Spaza',asset:zar,amount:'11',reference:'test'})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await expect(service.approve(1,execution.quote.id,execution.quote.hash,newId())).rejects.toThrow('QUOTE_ALREADY_APPROVED');
  });
  it('prevents overspending with another reservation and rejects changed approval',async()=>{
    await approved('70');await expect(approved('40')).rejects.toThrow('INSUFFICIENT');
    const invoice=await service.invoice(2,newId(),{merchant:'Spaza',asset:zar,amount:'10',reference:'x'}),quote=await service.quote(1,invoice.id,newId());
    await expect(service.approve(1,quote.id,'0'.repeat(64),newId())).rejects.toThrow('APPROVAL_MISMATCH');
  });
  it('rejects reads and recovery by another owner',async()=>{
    const e=await approved();await expect(service.get(2,e.id)).rejects.toThrow('NOT_FOUND');await expect(service.recover(2,e.id)).rejects.toThrow('NOT_FOUND');
  });
  it('prevents two quotes from paying the same invoice',async()=>{
    const invoice=await service.invoice(2,newId(),{merchant:'Spaza',asset:zar,amount:'10',reference:'once'});
    const first=await service.quote(1,invoice.id,newId()),second=await service.quote(1,invoice.id,newId());
    await service.approve(1,first.id,first.hash,newId());
    await expect(service.approve(1,second.id,second.hash,newId())).rejects.toThrow('INVOICE_ALREADY_IN_PROGRESS');
  });
  it('will not spend Testnet money on a live-network invoice',async()=>{
    const live={...zar,network:'public'},invoice=await service.invoice(2,newId(),{merchant:'Live shop',asset:live,amount:'10',reference:'isolation'});
    await expect(service.quote(1,invoice.id,newId())).rejects.toThrow('INSUFFICIENT');
  });
  it('serializes recovery with the execution worker by taking the job lock first',async()=>{
    const e=await approved();outcome='failed';await service.advance(1,e.id);
    const seen:string[]=[];const base=store.db;
    const recording={...base,transaction:<T,>(fn:(tx:Session)=>Promise<T>)=>base.transaction(tx=>fn({query:(text,params)=>{seen.push(text);return tx.query(text,params);}}))} as Database;
    const recovering=new PaymentService(new PaymentStore(recording),[new ManagedAdapter(store)],rail,()=>true);
    expect((await recovering.recover(1,e.id)).state).toBe('recovered');
    expect(seen[0]).toMatch(/FROM payment_jobs WHERE id=\$1 FOR UPDATE/);
  });
  it('retains funded money for explicit recovery after definitive payment failure',async()=>{
    const e=await approved();outcome='failed';expect((await service.advance(1,e.id)).state).toBe('recovery');
    expect((await service.recover(1,e.id)).state).toBe('recovered');expect((await store.balances(1))[0].available).toBe('100');
  });
  it('does not refund or replace an uncertain payment',async()=>{
    const e=await approved();outcome='pending';const current=await service.advance(1,e.id);expect(current.state).toBe('paying');
    await expect(service.recover(1,e.id)).rejects.toThrow('RECOVERY_NOT_AVAILABLE');
    expect((await store.balances(1))[0].available).toBe('30');
  });
  it('returns only confirmed unused funds when a failed transfer incurred fees',async()=>{
    const e=await approved();outcome='failed';unused='68';
    expect((await service.advance(1,e.id)).state).toBe('recovery');
    await service.advance(1,e.id);await service.recover(1,e.id);
    expect((await store.balances(1))[0].available).toBe('98');
    expect(await store.db.query('SELECT amount::text FROM payment_ledger WHERE reference=$1',[`${e.id}:failed-charge`])).toEqual([{amount:'2'}]);
  });
  it('ledger rejects asset mismatches and history rewrites',async()=>{
    await expect(store.db.transaction(async tx=>{const other=await store.account(tx,2,usd);await store.transfer(tx,account,other,zar,'1','bad');})).rejects.toThrow();
    await expect(store.db.query('DELETE FROM payment_ledger')).rejects.toThrow('append-only');
    expect((await store.balances(1))[0].available).toBe('100');
  });
  it('supports mixed Stellar and XRP funding without exposing simulation as real settlement',async()=>{
    const sourceA:Source={id:'stellar-a',asset:usd,available:'40',adapter:'fixture'},sourceB:Source={id:'xrp-b',asset:xrp,available:'60',adapter:'fixture'};
    const routes=[{...route('sa','40'),source:sourceA},{...route('xb','60'),source:sourceB}];
    service=new PaymentService(store,[new FixtureAdapter([sourceA,sourceB],routes)],rail,()=>true);
    const invoice=await service.invoice(2,newId(),{merchant:'Supplier',asset:zar,amount:'100',reference:'combined'}),quote=await service.quote(1,invoice.id,newId());
    expect(quote.simulated).toBe(true);expect(quote.allocations).toHaveLength(2);
    const e=await service.approve(1,quote.id,quote.hash,newId());expect((await service.advance(1,e.id)).state).toBe('paid');
  });
});
