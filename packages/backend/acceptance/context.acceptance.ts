import {it,expect} from "vitest";
import {acceptanceUrl} from "./database";
const env={XRPL_ACCEPTANCE_SANDBOX:"true",STELLAR_NETWORK:"testnet",XRPL_NETWORK:"testnet",XRPL_ACCEPTANCE_DATABASE:"amma_xrpl_acceptance_fixture",DATABASE_URL:"postgresql://acceptance:disposable-password@127.0.0.1:5432/amma_xrpl_acceptance_fixture"};
it("requires explicit sandbox, network, database name and local host identity",()=>{expect(acceptanceUrl(env)).toBe(env.DATABASE_URL);});
it.each([{XRPL_ACCEPTANCE_SANDBOX:"false"},{STELLAR_NETWORK:"public"},{XRPL_NETWORK:"mainnet"},{XRPL_ACCEPTANCE_DATABASE:"stellarwallet"},{DATABASE_URL:"postgresql://localhost/stellarwallet"},{DATABASE_URL:"postgresql://203.0.113.10/amma_xrpl_acceptance_fixture"},{DATABASE_URL:env.DATABASE_URL+"?application_name=override"}])("rejects unsafe acceptance context %j",override=>{expect(()=>acceptanceUrl({...env,...override})).toThrow();});
