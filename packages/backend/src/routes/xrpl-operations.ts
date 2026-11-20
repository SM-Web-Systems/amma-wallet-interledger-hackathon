import type { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { verifyInternalAdmin } from "../middleware/admin-auth";
import type { OperationsSnapshot } from "../modules/xrpl/operations";
import { submissionAvailability, type SubmissionAvailability } from "../modules/xrpl/submission-control";

/** Cached, aggregate-only monitor state. No public DB/endpoint diagnostic API. */
export async function xrplOperationsRoutes(app:FastifyInstance,options:{snapshot:()=>OperationsSnapshot;submission?:()=>SubmissionAvailability}) {
  app.get("/api/v1/internal/xrpl/operations",{config:{rateLimit:{max:10,timeWindow:"1 minute",keyGenerator:(request:FastifyRequest)=>request.ip}},onRequest:async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if(request.headers["x-api-key"]!==undefined)return reply.status(403).send({error:"Forbidden"});
    try{
      const authorization=request.headers.authorization;
      if(!authorization?.startsWith("Bearer "))return reply.status(401).send({error:"Unauthorized"});
      const payload=jwt.verify(authorization.slice(7),config.ADMIN_JWT_SECRET) as jwt.JwtPayload;
      if(payload.type!=="admin"||typeof payload.sub!=="string"||!/^[1-9]\d{0,14}$/.test(payload.sub))return reply.status(401).send({error:"Unauthorized"});
    }catch{return reply.status(401).send({error:"Unauthorized"});}
    try{await verifyInternalAdmin(request,reply);}catch{return reply.status(503).send({error:"Operations unavailable"});}
    if(reply.sent)return;
    if(!request.admin||!["super_admin","platform_admin"].includes(request.admin.role))return reply.status(403).send({error:"Forbidden"});
  }},async(_request,reply)=>{
    // The pause file is cheap to read and operators act on it, so never serve a cached value.
    const snapshot={...options.snapshot(),submission:(options.submission??submissionAvailability)()};
    if(snapshot.checkedAt&&Date.now()-Date.parse(snapshot.checkedAt)>600000)return reply.status(503).send({...snapshot,status:"unavailable"});
    return reply.status(["starting","unavailable"].includes(snapshot.status)?503:200).send(snapshot);
  });
}
