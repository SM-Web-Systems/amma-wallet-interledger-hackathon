import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authMiddleware } from '../middleware/auth';
import { PaymentFault, canonical, digest, requireThat, uuid, type Asset, type Invoice } from '../modules/payments/domain';
import type { PaymentService } from '../modules/payments/service';
import { verifyWebhook, type RafikiIdentity, type RafikiRail } from '../modules/payments/rafiki';
import { paymentsCanSubmit } from '../modules/payments/configuration';

type Options={service:PaymentService|null;rail?:RafikiRail;identity?:RafikiIdentity;assets?:{asset:Asset}[];authorize?:typeof authMiddleware};
const object=(properties:Record<string,unknown>,required:string[]=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const string={type:'string',minLength:1,maxLength:512};
const idParams=object({id:{type:'string',format:'uuid'}});
export async function paymentRoutes(app:FastifyInstance,options:Options) {
  const service=options.service;
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof PaymentFault)return reply.status(error.status).send({error:{code:error.code,message:error.code.replaceAll('_',' ')}});
    const code=(error as any).validation?'INVALID_REQUEST':'PAYMENT_SERVICE_UNAVAILABLE';
    return reply.status((error as any).validation?400:503).send({error:{code,message:code.replaceAll('_',' ')}});
  });
  app.get('/api/v1/payments/availability',async()=>({enabled:!!service,paused:!paymentsCanSubmit(),assets:(options.assets??[]).map(a=>a.asset)}));
  const guard=async(request:FastifyRequest,reply:any)=>{
    reply.header('Cache-Control','no-store');
    requireThat(service,'PAYMENTS_DISABLED',503);
    await (options.authorize??authMiddleware)(request,reply);
    if(reply.sent)return;
    requireThat(request.user?.type==='user'&&Number.isSafeInteger(request.user.userId),'USER_SESSION_REQUIRED',401);
  };
  const owner=(request:FastifyRequest)=>request.user!.userId;
  const key=(request:FastifyRequest)=>uuid(request.headers['idempotency-key']);
  const secure={preHandler:guard,config:{rateLimit:{max:30,timeWindow:'1 minute'}}};
  const assetSchema=object({chain:{enum:['stellar','xrpl','fiat']},network:string,code:string,scale:{type:'integer',minimum:0,maximum:18},issuer:string},['chain','network','code','scale']);
  app.get('/api/v1/payments/accounts',secure,async req=>service!.store.balances(owner(req)));
  app.get('/api/v1/payments/addresses',secure,async req=>service!.store.db.query('SELECT url,asset_key FROM payment_wallet_addresses WHERE owner_id=$1 ORDER BY url',[owner(req)]));
  app.get('/api/v1/payments/sources',secure,async req=>service!.sources(owner(req)));
  app.get('/api/v1/payments/history',secure,async req=>(await service!.store.db.query("SELECT body FROM payment_documents WHERE owner_id=$1 AND kind='execution' ORDER BY created_at DESC LIMIT 50",[owner(req)])).map(row=>row.body));
  app.post('/api/v1/payments/addresses',{...secure,schema:{body:object({asset:assetSchema,publicName:{type:'string',minLength:1,maxLength:100}})}},async req=>{
    requireThat(options.rail,'RAFIKI_UNAVAILABLE',503);const body=req.body as any;
    const address=new URL(`accounts/${key(req)}/${body.asset.code.toLowerCase()}`,process.env.PAYMENTS_WALLET_ADDRESS_BASE).toString();
    return options.rail.provision(owner(req),body.asset,address,body.publicName,key(req));
  });
  app.post('/api/v1/payments/requests',{...secure,schema:{body:object({merchant:{type:'string',minLength:1,maxLength:100},asset:assetSchema,
    amount:{type:'string',pattern:'^[1-9][0-9]{0,18}$'},reference:{type:'string',maxLength:100},walletAddress:string},['merchant','asset','amount','reference'])}},async req=>{
    const invoice=await service!.invoice(owner(req),key(req),req.body as any);
    if(options.rail&&invoice.walletAddress&&!invoice.incomingPayment){
      invoice.incomingPayment=await options.rail.incoming(invoice);
      await service!.store.db.transaction(async tx=>{
        await service!.store.put(tx,'invoice',invoice.id,invoice.owner,invoice);
        const id=uuid(new URL(invoice.incomingPayment!).pathname.split('/').pop());
        await service!.store.enqueue(tx,id,invoice.owner,'rafiki-incoming',{id});
      });
    }
    return invoice;
  });
  app.post('/api/v1/payments/requests/remote',{...secure,schema:{body:object({walletAddress:string,asset:assetSchema,amount:{type:'string',pattern:'^[1-9][0-9]{0,18}$'}})}},async req=>{
    requireThat(options.rail,'RAFIKI_UNAVAILABLE',503);const body=req.body as any;
    return service!.idempotent(owner(req),'remote-invoice',key(req),body,'invoice',async(tx,id)=>{
      const resolved=await options.rail!.remoteInvoice(body.walletAddress,body.asset,body.amount);
      const invoice:Invoice={id,owner:owner(req),asset:body.asset,amount:body.amount,reference:'Supplier payment',expiresAt:resolved.expiresAt,
        walletAddress:body.walletAddress,incomingPayment:resolved.incomingPayment,merchant:resolved.merchant};
      await service!.store.put(tx,'invoice',id,owner(req),invoice);return invoice;
    });
  });
  app.get('/api/v1/payments/requests/:id',{...secure,schema:{params:idParams}},async req=>{
    const invoice=await service!.store.get<Invoice>(service!.store.db,'invoice',uuid((req.params as any).id));
    const {owner:_owner,...publicInvoice}=invoice;return publicInvoice;
  });
  app.post('/api/v1/payments/quotes',{...secure,schema:{body:object({requestId:{type:'string',format:'uuid'},excludedSources:{type:'array',maxItems:32,items:string}},['requestId'])}},async req=>{
    const body=req.body as any;return service!.quote(owner(req),body.requestId,key(req),body.excludedSources??[]);
  });
  app.post('/api/v1/payments/approvals',{...secure,schema:{body:object({quoteId:{type:'string',format:'uuid'},hash:{type:'string',pattern:'^[0-9a-f]{64}$'}})}},async req=>{
    const body=req.body as any;return service!.approve(owner(req),body.quoteId,body.hash,key(req));
  });
  app.get('/api/v1/payments/executions/:id',{...secure,schema:{params:idParams}},async req=>service!.get(owner(req),(req.params as any).id));
  app.post('/api/v1/payments/executions/:id/signatures',{...secure,bodyLimit:40_000,schema:{params:idParams,body:object({legId:{type:'string',format:'uuid'},signedTransaction:{type:'string',minLength:1,maxLength:32_768}})}},async req=>{
    const body=req.body as any;return service!.signature(owner(req),(req.params as any).id,body.legId,body.signedTransaction);
  });
  app.post('/api/v1/payments/executions/:id/recover',{...secure,schema:{params:idParams,body:object({})}},async req=>service!.recover(owner(req),(req.params as any).id));
  app.get('/api/v1/payments/executions/:id/receipt',{...secure,schema:{params:idParams}},async req=>{
    const execution=await service!.get(owner(req),(req.params as any).id);requireThat(execution.state==='paid','RECEIPT_NOT_AVAILABLE',409);return execution.receipt;
  });
  app.post('/api/v1/payments/webhooks/rafiki',{bodyLimit:65_536},async(req,reply)=>{
    requireThat(service,'PAYMENTS_DISABLED',503);
    requireThat(verifyWebhook(process.env.RAFIKI_WEBHOOK_SECRET??'',req.headers['rafiki-signature'],req.body),'INVALID_WEBHOOK_SIGNATURE',401);
    const event=req.body as any;uuid(event?.id);requireThat(typeof event.type==='string'&&event.data&&typeof event.data==='object','INVALID_WEBHOOK');
    await service.store.db.transaction(async tx=>{
      const hash=digest(event);
      await tx.query('INSERT INTO payment_webhooks(id,digest,payload) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING',[event.id,hash,canonical(event)]);
      const [saved]=await tx.query('SELECT digest FROM payment_webhooks WHERE id=$1',[event.id]);requireThat(saved.digest===hash,'WEBHOOK_REPLAY_CONFLICT',409);
      await service.store.enqueue(tx,event.id,0,'rafiki-webhook',event);
    });return reply.status(200).send({accepted:true});
  });
  app.get('/api/v1/payments/consent/:id/:nonce',secure,async req=>{
    requireThat(options.identity,'IDENTITY_UNAVAILABLE',503);const {id,nonce}=req.params as any;return options.identity.view(owner(req),id,nonce);
  });
  app.get('/api/v1/payments/grants',secure,async req=>{requireThat(options.identity,'IDENTITY_UNAVAILABLE',503);return options.identity.grants(owner(req));});
  app.post('/api/v1/payments/grants/:id/revoke',{...secure,schema:{params:idParams,body:object({})}},async req=>{
    requireThat(options.identity,'IDENTITY_UNAVAILABLE',503);return options.identity.revoke(owner(req),uuid((req.params as any).id));
  });
  app.post('/api/v1/payments/consent/:id/:nonce',{...secure,schema:{body:object({hash:{type:'string',pattern:'^[0-9a-f]{64}$'},approve:{type:'boolean'}})}},async req=>{
    requireThat(options.identity,'IDENTITY_UNAVAILABLE',503);const {id,nonce}=req.params as any,body=req.body as any;
    return options.identity.choose(owner(req),id,nonce,body.hash,body.approve);
  });
}
