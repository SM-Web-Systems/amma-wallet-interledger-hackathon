import {describe,it,expect,vi,afterEach} from 'vitest';
import Fastify from 'fastify';
vi.mock('../middleware/auth',()=>({authMiddleware:async(req:any,reply:any)=>{
  if(req.headers.authorization!=='Bearer fixture')return reply.status(401).send({error:'Unauthorized'});
  req.user={type:'user',userId:1};
}}));
import {paymentRoutes} from './payments';
import {signature} from '../modules/payments/rafiki';
const instances:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(instances.splice(0).map(app=>app.close()));vi.unstubAllEnvs();});
async function app(service:any=null){const server=Fastify();instances.push(server);await server.register(paymentRoutes,{service});return server;}
describe('payment API boundaries',()=>{
  it('keeps the feature disabled by default',async()=>{
    const server=await app();expect((await server.inject('/api/v1/payments/availability')).json().enabled).toBe(false);
    expect((await server.inject('/api/v1/payments/accounts')).statusCode).toBe(503);
  });
  it('requires an authenticated personal session',async()=>{
    const server=await app({store:{balances:vi.fn()}});
    expect((await server.inject('/api/v1/payments/accounts')).statusCode).toBe(401);
  });
  it('takes account ownership from the session',async()=>{
    const balances=vi.fn().mockResolvedValue([]),server=await app({store:{balances}});
    expect((await server.inject({url:'/api/v1/payments/accounts',headers:{authorization:'Bearer fixture'}})).statusCode).toBe(200);
    expect(balances).toHaveBeenCalledWith(1);
  });
  it('rejects malformed approvals before calling the service',async()=>{
    const approve=vi.fn(),server=await app({approve});
    expect((await server.inject({method:'POST',url:'/api/v1/payments/approvals',headers:{authorization:'Bearer fixture'},payload:{quoteId:'bad',hash:'bad'}})).statusCode).toBe(400);
    expect(approve).not.toHaveBeenCalled();
  });
  it('rejects unsigned webhook bodies before touching storage',async()=>{
    const transaction=vi.fn(),server=await app({store:{db:{transaction}}});
    const response=await server.inject({method:'POST',url:'/api/v1/payments/webhooks/rafiki',payload:{id:'11111111-1111-4111-8111-111111111111'}});
    expect(response.statusCode).toBe(401);expect(transaction).not.toHaveBeenCalled();
  });
});
