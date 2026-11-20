import {afterAll,beforeAll,describe,it,expect} from "vitest";
import {createServer,type Server} from "node:http";
import {StellarToml} from "@stellar/stellar-sdk";
let server:Server,domain:string,content:string;
const compatibleSdks=[{name:"backend Stellar SDK",resolve:StellarToml.Resolver.resolve},
  {name:"wallet-kit nested Stellar SDK",resolve:require("@stellar/typescript-wallet-sdk/node_modules/@stellar/stellar-sdk").StellarToml.Resolver.resolve as typeof StellarToml.Resolver.resolve}];
beforeAll(async()=>{
  server=createServer((_request,response)=>{response.setHeader("Content-Type","text/plain");response.end(content);});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("No local fixture");domain=`127.0.0.1:${address.port}`;
});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
describe.each(compatibleSdks)("patched TOML compatibility: $name",sdk=>{
  it("retains the actual SDK resolver's standard Stellar metadata shape",async()=>{
    content='VERSION="2.0.0"\nNETWORK_PASSPHRASE="Test SDF Network ; September 2015"\n[DOCUMENTATION]\nORG_NAME="Amma fixture"\n[[CURRENCIES]]\ncode="AMMA"\ndisplay_decimals=7\n';
    const result=await sdk.resolve(domain,{allowHttp:true,timeout:2000});expect(result).toMatchObject({VERSION:"2.0.0",DOCUMENTATION:{ORG_NAME:"Amma fixture"},CURRENCIES:[{code:"AMMA",display_decimals:7}]});
  });
  it("does not pollute process prototypes through remote TOML key paths",async()=>{
    content='[__proto__]\namma_m8_polluted="unsafe"\n';
    await sdk.resolve(domain,{allowHttp:true,timeout:2000}).catch(()=>{});
    expect(({} as Record<string,unknown>).amma_m8_polluted).toBeUndefined();expect(Object.prototype).not.toHaveProperty("amma_m8_polluted");
  });
  it("retains the SDK's document-size ceiling",async()=>{
    content='X="'+'a'.repeat(110000)+'"';await expect(sdk.resolve(domain,{allowHttp:true,timeout:2000})).rejects.toThrow(/size/);
  });
});
