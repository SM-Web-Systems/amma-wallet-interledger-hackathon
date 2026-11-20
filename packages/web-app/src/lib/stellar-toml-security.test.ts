// @vitest-environment node
// Crypto/IndexedDB library test: jsdom's realm breaks Uint8Array identity checks in @noble and Stellar SDKs.
import {afterAll,beforeAll,it,expect} from "vitest";
import {createServer,type Server} from "node:http";
import {StellarToml} from "@stellar/stellar-sdk";
let server:Server,domain:string,content:string;
beforeAll(async()=>{server=createServer((_request,response)=>{response.setHeader("Content-Type","text/plain");response.end(content);});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("No local fixture");domain=`127.0.0.1:${address.port}`;});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
it("retains the browser package SDK resolver metadata with the fixed parser",async()=>{
  content='VERSION="2.0.0"\n[DOCUMENTATION]\nORG_NAME="Amma fixture"\n[[CURRENCIES]]\ncode="AMMA"\n';
  expect(await StellarToml.Resolver.resolve(domain,{allowHttp:true,timeout:2000})).toMatchObject({DOCUMENTATION:{ORG_NAME:"Amma fixture"},CURRENCIES:[{code:"AMMA"}]});
});
it("does not pollute object prototypes from untrusted Stellar metadata",async()=>{
  content='[__proto__]\namma_m8_polluted="unsafe"\n';await StellarToml.Resolver.resolve(domain,{allowHttp:true,timeout:2000}).catch(()=>{});expect(({} as Record<string,unknown>).amma_m8_polluted).toBeUndefined();
});
