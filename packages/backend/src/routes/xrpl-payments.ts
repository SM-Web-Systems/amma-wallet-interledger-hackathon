import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { verifyAccessToken } from "../lib/auth";
import { XrplReadError } from "../modules/xrpl/validation";
import { PaymentError, strictObject } from "../modules/xrpl/payment";
import { XrplPaymentService, type PaymentApplication, type PaymentNetwork } from "../modules/xrpl/payment-service";

import { requireXrplApplication, type XrplApplicationScope } from "../middleware/xrpl-application";
import {assertSubmissionAllowed,gateAvailability,type SubmissionGate} from "../modules/xrpl/submission-control";
import { xrplIntegrationOpenApi } from "../modules/xrpl/integration-openapi";

declare module "fastify" { interface FastifyRequest { xrplApplication?: PaymentApplication } }

export async function xrplPaymentRoutes(app: FastifyInstance, options: { network?: PaymentNetwork; submissionGate?:SubmissionGate } = {}) {
  const submissionGate=options.submissionGate??assertSubmissionAllowed;
  const service = new XrplPaymentService(options.network,submissionGate);
  const fail = (request: FastifyRequest, reply: FastifyReply, status: number, code: string, retryable = false) => reply.status(status).send({ error: { code, message: code.replaceAll("_", " "), retryable, requestId: request.id } });
  app.setErrorHandler((cause,request,reply)=>{
    const status=(cause as {statusCode?:number}).statusCode??503;
    return fail(request,reply,status>=400&&status<600?status:503,status===413?"REQUEST_TOO_LARGE":status===429?"RATE_LIMITED":status<500?"INVALID_REQUEST":"PAYMENT_STORAGE_UNAVAILABLE",status===429||status>=500);
  });
  const guard = (scope?: XrplApplicationScope, applicationRequired=false) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control","no-store");
    // Browser-signed and tenant XRP payments stay testnet-only; on mainnet only Amma-held wallets send (routes/custody-send).
    if (!config.XRPL.enabled || !config.XRPL_PAYMENTS_ENABLED || (config.XRPL.network ?? "testnet") !== "testnet") return fail(request, reply, 503, "XRPL_PAYMENTS_DISABLED");
    try {
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith("Bearer ")) return fail(request, reply, 401, "USER_SESSION_REQUIRED");
      request.user = verifyAccessToken(authorization.slice(7));
    } catch { return fail(request, reply, 401, "USER_SESSION_REQUIRED"); }
    if (request.user?.type !== "user" || !Number.isSafeInteger(request.user.userId) || request.user.userId <= 0) return fail(request, reply, 401, "USER_SESSION_REQUIRED");
    if (request.headers["x-api-key"] !== undefined || applicationRequired) {
      if(!scope)return fail(request,reply,403,"USER_SESSION_REQUIRED");
      if(!config.XRPL_INTEGRATION_ENABLED)return fail(request,reply,503,"XRPL_INTEGRATION_DISABLED");
      try { request.xrplApplication=await requireXrplApplication(request.headers["x-api-key"],request.user.userId,scope); }
      catch(cause){if(cause instanceof PaymentError)return fail(request,reply,cause.status,cause.code,cause.retryable);return fail(request,reply,503,"APPLICATION_AUTH_UNAVAILABLE",true);}
    }
  };
  // Do not use the global raw X-API-Key rate key: arbitrary header rotation
  // must not bypass signing limits. Only a verified personal identity is used.
  const rateKey=(request:FastifyRequest)=>{
    try {const authorization=request.headers.authorization;if(!authorization?.startsWith("Bearer "))return request.ip;const user=verifyAccessToken(authorization.slice(7));if(user.type==="user"&&Number.isSafeInteger(user.userId)&&user.userId>0)return `xrpl:user:${user.userId}`;}catch{}
    return request.ip;
  };
  const common = { onRequest: guard(), bodyLimit: 6144, config: { rateLimit: { max: 20, timeWindow: "1 minute",keyGenerator:rateKey } } };
  const signing={...common,config:{rateLimit:{max:5,timeWindow:"1 minute",keyGenerator:rateKey}}};
  const safe = (work: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try { return await work(request, reply); }
    catch (cause) {
      if (cause instanceof PaymentError) return fail(request, reply, cause.status, cause.code, cause.retryable);
      if (cause instanceof XrplReadError) return fail(request, reply, 503, cause.code, cause.retryable);
      request.log.warn({ event: "xrpl_payment_storage_unavailable", requestId: request.id }, "XRP payment operation unavailable");
      return fail(request, reply, 503, "PAYMENT_STORAGE_UNAVAILABLE", true);
    }
  };
  const owner = (request: FastifyRequest) => request.user!.userId;
  const id = (request: FastifyRequest) => (request.params as { id: string }).id;
  const empty = (request: FastifyRequest) => { strictObject(request.body, []); };
  const base = "/api/v1/xrpl/payment-intents";
  const external = (payment: Awaited<ReturnType<typeof service.create>>) => {
    const {preparation: _preparation, receipt: _receipt, ...publicStatus}=payment;
    return publicStatus;
  };
  const bound = async(request: FastifyRequest) => { if(request.xrplApplication)await service.assertApplication(owner(request),id(request),request.xrplApplication); };
  const scoped = (scope:XrplApplicationScope,required=false) => ({...common,onRequest:guard(scope,required)});
  // Public static contract contains no credentials and enables independent clients.
  app.get("/api/v1/xrpl/openapi.json",async()=>xrplIntegrationOpenApi);
  app.get("/api/v1/xrpl/payment-availability",common,async()=>({chain:"xrpl",network:"testnet",...gateAvailability(submissionGate)}));
  app.post(base, scoped("xrpl:payments:create"), safe(async request => {
    const payment=await service.create(owner(request),request.body,request.headers["idempotency-key"],request.xrplApplication);
    return request.xrplApplication?external(payment):payment;
  }));
  app.get(base, common, safe(async request => { const query = strictObject(request.query, ["walletId"]); return service.list(owner(request), String(query.walletId)); }));
  app.get(`${base}/:id`, scoped("xrpl:payments:read"), safe(async request => {
    await bound(request);const payment=await service.status(owner(request),id(request));return request.xrplApplication?external(payment):payment;
  }));
  app.post(`${base}/:id/prepare`, signing, safe(async request => { empty(request); return service.prepare(owner(request), id(request)); }));
  app.post(`${base}/:id/submit`, signing, safe(async (request, reply) => {
    const body = strictObject(request.body, ["preparationId", "blob"]);
    if (typeof body.preparationId !== "string") throw new PaymentError("INVALID_SCHEMA", 400);
    const payment = await service.submit(owner(request), id(request), body.preparationId, body.blob);
    return reply.status(["validated_success", "validated_failure", "expired"].includes(payment.state) ? 200 : 202).send(payment);
  }));
  app.post(`${base}/:id/rebroadcast`, signing, safe(async request => { empty(request); return service.rebroadcast(owner(request), id(request)); }));
  app.post(`${base}/:id/cancel`, common, safe(async request => { empty(request); return service.cancel(owner(request), id(request)); }));
  app.get(`${base}/:id/receipt`, scoped("xrpl:payments:read"), safe(async request => { await bound(request);return service.receipt(owner(request),id(request)); }));
  app.post(`${base}/:id/claims`, scoped("xrpl:receipts:claim",true), safe(async request => service.claim(owner(request),id(request),request.xrplApplication!,request.body)));
}
