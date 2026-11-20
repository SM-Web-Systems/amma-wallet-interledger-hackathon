// Explicit offline acceptance entrypoint. Does not bootstrap background jobs.
import {existsSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import {isValidClassicAddress} from "xrpl";
import {xrplWalletRoutes} from "../routes/xrpl-wallets";
import {xrplPaymentRoutes} from "../routes/xrpl-payments";
import {xrplOperationsRoutes} from "../routes/xrpl-operations";
import {initialSnapshot} from "../modules/xrpl/operations";
async function main(){
  if(process.env.XRPL_ACCEPTANCE_SANDBOX!=="true"||[process.env.XRPL_ENABLED,process.env.XRPL_PAYMENTS_ENABLED,process.env.XRPL_INTEGRATION_ENABLED,process.env.XRPL_RECONCILIATION_ENABLED,process.env.XRPL_MONITORING_ENABLED].some(flag=>flag!=="false"))throw new Error("Offline disabled acceptance environment required");
  if(!["x64","arm64"].includes(process.env.XRPL_ACCEPTANCE_EXPECT_ARCH??"")||process.arch!==process.env.XRPL_ACCEPTANCE_EXPECT_ARCH)throw new Error("Image architecture mismatch");
  if(!/^[a-f0-9]{40}$/.test(process.env.AMMA_BUILD_REVISION??""))throw new Error("Reviewed image revision required");
  if(typeof process.getuid!=="function"||process.getuid()===0)throw new Error("Non-root Linux runtime required");
  if(existsSync(resolve("node_modules/@electric-sql/pglite")))throw new Error("Embedded test database must not ship in runtime");
  if(!isValidClassicAddress("rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"))throw new Error("SDK unavailable");
  const sdk=JSON.parse(readFileSync(resolve("node_modules/xrpl/package.json"),"utf8"));if(sdk.version!=="5.3.0")throw new Error("Unreviewed SDK version");
  const app=Fastify({logger:false});await app.register(staticPlugin,{root:resolve("assets/icons"),prefix:"/assets/icons/"});
  await app.register(xrplWalletRoutes);await app.register(xrplPaymentRoutes);await app.register(xrplOperationsRoutes,{snapshot:()=>initialSnapshot(false)});
  try{
    if((await app.inject({method:"POST",url:"/api/v1/xrpl/wallets",payload:{}})).statusCode!==503)throw new Error("Wallet flag guard failed");
    if((await app.inject({method:"POST",url:"/api/v1/xrpl/payment-intents",payload:{}})).statusCode!==503)throw new Error("Payment flag guard failed");
    if((await app.inject({url:"/api/v1/internal/xrpl/operations"})).statusCode!==401)throw new Error("Operations guard failed");
  }finally{await app.close();}
  console.log(JSON.stringify({status:"passed",scope:"non-root production dependency image; disabled real routes; no server jobs or public RPC",node:process.versions.node,arch:process.arch,sdk:sdk.version,fastify:app.version}));
}
main().catch(()=>{console.error("Production image smoke failed; details redacted");process.exitCode=1;});
