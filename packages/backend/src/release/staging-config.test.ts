import {it,expect} from "vitest";
import {stagingIdentity} from "./staging-config";
const revision="a".repeat(40),args=["--expect-database=stellarwallet_testnet","--expect-db-host=amma-db-testnet",`--expect-revision=${revision}`];
const env={AMMA_BUILD_REVISION:revision,STELLAR_NETWORK:"testnet",XRPL_NETWORK:"testnet",XRPL_ENABLED:"true",XRPL_PAYMENTS_ENABLED:"true",XRPL_INTEGRATION_ENABLED:"true",XRPL_RECONCILIATION_ENABLED:"true",XRPL_MONITORING_ENABLED:"true"};
it("requires a reviewed revision and an explicit isolated operational configuration",()=>{expect(stagingIdentity(args,env)).toEqual({database:"stellarwallet_testnet",host:"amma-db-testnet",revision});});
it.each([{AMMA_BUILD_REVISION:"unknown"},{STELLAR_NETWORK:"public"},{XRPL_NETWORK:"mainnet"},{XRPL_RECONCILIATION_ENABLED:"false"},{XRPL_MONITORING_ENABLED:"false"},{XRPL_ENABLED:"false"}])("blocks unreviewed/unsafe staging configuration %j",override=>{expect(()=>stagingIdentity(args,{...env,...override})).toThrow();});
it("does not accept missing/duplicate identities or a caller-selected URL",()=>{for(const input of [args.slice(0,2),[...args,"--apply"],[args[0],args[0],args[2]],["--expect-database=postgresql://mainnet",args[1],args[2]]])expect(()=>stagingIdentity(input,env)).toThrow();});
