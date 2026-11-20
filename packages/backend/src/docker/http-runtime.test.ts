import {it,expect} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,rmdirSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import Fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import staticPlugin from "@fastify/static";
it("keeps Swagger/static compatibility and confines encoded file paths after the runtime patches",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"amma-http-acceptance-")),assets=join(dir,"icons");mkdirSync(assets);writeFileSync(join(assets,"public.svg"),"<svg/>");writeFileSync(join(dir,"private.txt"),"PRIVATE_FIXTURE_MUST_NOT_ESCAPE");
  const app=Fastify();
  try{
    await app.register(swagger,{openapi:{info:{title:"Acceptance",version:"1"}}});await app.register(swaggerUi,{routePrefix:"/docs"});await app.register(staticPlugin,{root:assets,prefix:"/assets/icons/",decorateReply:false});
    app.get("/api/v1/xrpl/protected",{onRequest:async(_request,reply)=>reply.status(401).send({error:"Unauthorized"})},async()=>({private:"MUST_NOT_REACH"}));
    expect((await app.inject("/docs/json")).statusCode).toBe(200);expect((await app.inject("/docs/static/swagger-ui.css")).statusCode).toBe(200);expect((await app.inject("/assets/icons/public.svg")).body).toBe("<svg/>");
    for(const path of ["../private.txt","%2e%2e/private.txt","%252e%252e/private.txt",".%2e/private.txt","%2e%2e%2fprivate.txt"]){const response=await app.inject(`/assets/icons/${path}`);expect(response.body).not.toContain("PRIVATE_FIXTURE_MUST_NOT_ESCAPE");}
    for(const path of ["/api/v1/xrpl/protected","/api/v1/xrpl/./protected","/api/v1/xrpl/%2e/protected"]){const response=await app.inject(path);expect(response.statusCode).not.toBe(200);expect(response.body).not.toContain("MUST_NOT_REACH");}
  }finally{await app.close();unlinkSync(join(assets,"public.svg"));unlinkSync(join(dir,"private.txt"));rmdirSync(assets);rmdirSync(dir);}
});
