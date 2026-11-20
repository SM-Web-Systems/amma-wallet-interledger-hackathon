import { describe,it,expect,vi,afterEach } from 'vitest';
import { signature,verifyWebhook,RafikiIdentity,RafikiRail } from './rafiki';
import {PaymentStore} from './store';
describe('Rafiki message integrity',()=>{
  const secret='a'.repeat(32),now=1793433600000;
  it('verifies canonical payloads and rejects tampering, expiry and unsupported versions',()=>{
    const body={id:'test',data:{z:'2',a:'1'}},header=signature(secret,body,now);
    expect(verifyWebhook(secret,header,{data:{a:'1',z:'2'},id:'test'},now)).toBe(true);
    expect(verifyWebhook(secret,header,{...body,id:'other'},now)).toBe(false);
    expect(verifyWebhook(secret,header,body,now+31_000)).toBe(false);
    expect(verifyWebhook(secret,header.replace('v1','v2'),body,now)).toBe(false);
    expect(verifyWebhook(secret,'invalid',body,now)).toBe(false);
  });
});

describe('GNAP account ownership and approval binding',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  const identifier='https://amma.example/accounts/one';
  function setup(access:any[]){
    const fetcher=vi.fn().mockImplementation(async(_url,options)=>new Response(options?.method==='POST'?'':JSON.stringify({grantId:'11111111-1111-4111-8111-111111111111',access,state:'pending'}),{status:options?.method==='POST'?202:200}));
    vi.stubGlobal('fetch',fetcher);
    const query=vi.fn().mockImplementation(async(_sql,params)=>params[0]===identifier&&params[1]===1?[{url:identifier}]:[]);
    const store=new PaymentStore({query,transaction:vi.fn()} as any);vi.spyOn(store,'put').mockResolvedValue(undefined);
    return {identity:new RafikiIdentity(store,'https://private-identity.example','secret','https://auth.amma.example'),fetcher,store};
  }
  const access=()=>({type:'outgoing-payment',actions:['create','read'],identifier,limits:{debitAmount:{value:'100',assetCode:'ZARC',assetScale:7}}});
  it('rejects another owner and outgoing authority without a bounded debit',async()=>{
    const {identity}=setup([access()]);await expect(identity.view(2,'interaction','nonce')).rejects.toThrow('GRANT_NOT_OWNED');
    const unbounded=setup([{...access(),limits:undefined}]);await expect(unbounded.identity.view(1,'interaction','nonce')).rejects.toThrow('UNBOUNDED_GRANT_DENIED');
  });
  it('rejects changed scope before accepting and returns only the configured auth finish URL',async()=>{
    const {identity,fetcher}=setup([access()]);const reviewed=await identity.view(1,'interaction','nonce');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({grantId:'11111111-1111-4111-8111-111111111111',access:[{...access(),actions:['create','read','list']}],state:'pending'})));
    await expect(identity.choose(1,'interaction','nonce',reviewed.hash,true)).rejects.toThrow('GRANT_CHANGED');
    expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(0);
    expect((await identity.choose(1,'interaction','nonce',reviewed.hash,false)).finishUrl).toBe('https://auth.amma.example/interact/interaction/nonce/finish');
    expect(fetcher.mock.calls.at(-1)?.[0].toString()).toBe('https://private-identity.example/grant/interaction/nonce/reject');
  });
});

describe('Rafiki outgoing payment idempotency',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('funds with a key distinct from the create key, because Rafiki scopes keys across mutations',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
    const store=new PaymentStore({query:vi.fn().mockResolvedValue([]),transaction:vi.fn()} as any);vi.spyOn(store,'put').mockResolvedValue(undefined);
    const keys:string[]=[];
    const admin={call:vi.fn().mockImplementation(async(_q:string,v:any)=>{keys.push(v.input.idempotencyKey);return {createOutgoingPayment:{payment:{id:'op-1'}},depositOutgoingPaymentLiquidity:{success:true}};})};
    (admin as any).fund=async(id:string,key:string)=>{keys.push(key);};
    const rail=new RafikiRail(store,admin as any,[],'https://pay-a.example/amma','kid','unused',['https://pay-a.example'],()=>true);
    const execution={id:'22222222-2222-4222-8222-222222222222',owner:1,quote:{rail:{senderId:'s',quoteId:'q'}}} as any;
    await rail.prepare(execution);
    expect(keys).toHaveLength(2);expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(execution.id);
  });
});

describe('Rafiki definitive rejections',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it('reports BAD_USER_INPUT as a definitive rejection, distinct from an unavailable admin API',async()=>{
    const {RafikiAdmin}=await import('./rafiki');
    const reply=(body:unknown)=>vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status:200}));
    vi.stubGlobal('fetch',reply({data:null,errors:[{message:'invalid quote',extensions:{code:'BAD_USER_INPUT'}}]}));
    const admin=new RafikiAdmin('https://admin.example/graphql','tenant','s'.repeat(32));
    await expect(admin.call('mutation{x}',{})).rejects.toMatchObject({code:'RAFIKI_INPUT_REJECTED',status:409});
    vi.stubGlobal('fetch',reply({data:null,errors:[{message:'boom',extensions:{code:'INTERNAL_SERVER_ERROR'}}]}));
    await expect(admin.call('mutation{x}',{})).rejects.toMatchObject({code:'RAFIKI_OPERATION_FAILED',status:503});
    vi.stubGlobal('fetch',reply({data:null,errors:[{message:'payment does not exist',extensions:{code:'NOT_FOUND'}}]}));
    await expect(admin.call('query{x}',{})).rejects.toMatchObject({code:'RAFIKI_NOT_FOUND',status:404});
  });
  const setup=(existing:unknown)=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
    const query=vi.fn().mockResolvedValue([]);
    const store=new PaymentStore({query,transaction:vi.fn()} as any);vi.spyOn(store,'put').mockResolvedValue(undefined);
    const admin={call:vi.fn().mockImplementation(async(q:string)=>{
      if(q.includes('createOutgoingPayment')){const {PaymentFault}=await import('./domain');throw new PaymentFault('RAFIKI_INPUT_REJECTED',409);}
      if(q.includes('outgoingPayment(')){if(existing)return {outgoingPayment:existing};const {PaymentFault}=await import('./domain');throw new PaymentFault('RAFIKI_NOT_FOUND',404);}
      throw new Error('unexpected');
    }),fund:vi.fn()};
    const rail=new RafikiRail(store,admin as any,[],'https://pay-a.example/amma','kid','unused',['https://pay-a.example'],()=>true);
    const execution={id:'33333333-3333-4333-8333-333333333333',owner:1,quote:{receive:'1515152',expiresAt:new Date(Date.now()+60_000).toISOString(),
      rail:{senderId:'s',quoteId:'44444444-4444-4444-8444-444444444444',debit:'1515152'}}} as any;
    return {rail,execution,admin};
  };
  it('fails with nothing consumed when Rafiki rejects the create and no outgoing payment exists',async()=>{
    const {rail,execution,admin}=setup(null);
    await expect(rail.observe(execution)).resolves.toMatchObject({state:'failed',evidence:{unused:'1515152'}});
    expect(admin.fund).not.toHaveBeenCalled();
  });
  it('never fails a payment whose outgoing payment exists, even if a retried create is rejected',async()=>{
    const {rail,execution}=setup({id:'44444444-4444-4444-8444-444444444444'});
    await expect(rail.observe(execution)).rejects.toMatchObject({code:'RAFIKI_INPUT_REJECTED'});
  });
  it('fails an expired, never-created payment instead of leaving it unknown forever',async()=>{
    const {rail,execution,admin}=setup(null);execution.quote.expiresAt=new Date(Date.now()-1000).toISOString();
    // Inside Rafiki's own quote lifespan a create could still land: stay unknown.
    await expect(rail.observe(execution)).resolves.toMatchObject({state:'unknown'});
    execution.quote.expiresAt=new Date(Date.now()-6*60_000).toISOString();
    await expect(rail.observe(execution)).resolves.toMatchObject({state:'failed',evidence:{unused:'1515152'}});
    expect(admin.call.mock.calls.some(([q]:any)=>q.includes('createOutgoingPayment'))).toBe(false);
  });
});

describe('GNAP grant listing reflects the authorization server',()=>{
  const listed=(bodies:any[],admin?:any)=>{
    const store=new PaymentStore({query:vi.fn().mockResolvedValue(bodies.map(body=>({body})))} as any);
    return new RafikiIdentity(store,'https://private-identity.example','secret','https://auth.amma.example',admin).grants(1);
  };
  it('shows an approved grant the client never continued as awaiting the client, not active',async()=>{
    const states:Record<string,any>={a:{state:'APPROVED',finalizationReason:null},b:{state:'FINALIZED',finalizationReason:'ISSUED'},c:{state:'FINALIZED',finalizationReason:'REVOKED'},d:{state:'FINALIZED',finalizationReason:'REJECTED'}};
    const admin={call:vi.fn().mockImplementation(async(_q:string,v:any)=>({grant:{id:v.id,...states[v.id]}}))};
    const grants=await listed(['a','b','c','d'].map(id=>({id,access:[],revoked:false})),admin);
    expect(grants.map((g:any)=>[g.id,g.status,g.revoked])).toEqual([['a','awaiting_client',false],['b','active',false],['c','revoked',true],['d','rejected',true]]);
  });
  it('keeps the stored record, marked unverified, when the authorization server is unavailable',async()=>{
    const admin={call:vi.fn().mockRejectedValue(new Error('offline'))};
    expect(await listed([{id:'a',access:[],revoked:false}],admin)).toEqual([{id:'a',access:[],revoked:false,status:'unverified'}]);
    expect(await listed([{id:'a',access:[],revoked:true}],admin)).toEqual([{id:'a',access:[],revoked:true,status:'revoked'}]);
  });
});
