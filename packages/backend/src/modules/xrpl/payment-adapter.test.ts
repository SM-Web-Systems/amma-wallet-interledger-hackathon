import { describe, expect, it, vi } from "vitest";
import { Wallet } from "xrpl";
import { XrplPaymentAdapter } from "./payment-adapter";
import { readXrplPaymentsEnabled, TESTNET_ENDPOINTS } from "./config";
import type { ReadRequest } from "./read-adapter";

const source=Wallet.generate(), destination=Wallet.generate();
const blob=source.sign({TransactionType:"Payment",Account:source.classicAddress,Destination:destination.classicAddress,Amount:"1000000",Fee:"12",Sequence:1,LastLedgerSequence:1254}).tx_blob;
function connection(network=1, seq=1234) {
  return {connect:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{}),submit:vi.fn(async()=>({result:{engine_result:"tesSUCCESS"}})),request:vi.fn(async(request:ReadRequest)=>({result:request.command==="server_info"?{info:{network_id:network,server_state:"full",validated_ledger:{seq,hash:"A".repeat(64),age:1}}}:{validated:true,ledger_index:seq,ledger_hash:"A".repeat(64),ledger:{close_time:Math.floor(Date.now()/1000)-946684800-1}}}))};
}
describe("Testnet signed-only submission transport",()=>{
  it("keeps payments independently disabled and validates enablement",()=>{
    expect(readXrplPaymentsEnabled({XRPL_ENABLED:"true"})).toBe(false);
    expect(()=>readXrplPaymentsEnabled({XRPL_PAYMENTS_ENABLED:"yes"})).toThrow();
    expect(()=>readXrplPaymentsEnabled({XRPL_PAYMENTS_ENABLED:"true"})).toThrow();
    expect(readXrplPaymentsEnabled({XRPL_ENABLED:"true",XRPL_PAYMENTS_ENABLED:"true"})).toBe(true);
  });
  it("anchors the actual submitting connection to Testnet before submitting exact bytes",async()=>{
    const client=connection();
    const result=await new XrplPaymentAdapter({XRPL_ENABLED:"true",XRPL_RPC_URLS:TESTNET_ENDPOINTS[0]},()=>client,()=>{}).submitSigned(blob,1254);
    expect(result).toEqual({provisionalResult:"tesSUCCESS"}); expect(client.submit).toHaveBeenCalledWith(blob);
    expect(client.request.mock.calls.map(([r])=>r.command)).toEqual(["server_info","ledger"]);expect(client.disconnect).toHaveBeenCalledOnce();
  });
  it("does not submit on mainnet, when disabled, or beyond the ledger bound",async()=>{
    for(const [env,client,bound] of [[{},connection(),1254],[{XRPL_ENABLED:"true"},connection(0),1254],[{XRPL_ENABLED:"true"},connection(1,1255),1254]] as const) {
      await expect(new XrplPaymentAdapter({...env,XRPL_RPC_URLS:TESTNET_ENDPOINTS[0]},()=>client,()=>{}).submitSigned(blob,bound)).rejects.toThrow();
      expect(client.submit).not.toHaveBeenCalled();
    }
  });
  it("fails over only with the same signed blob after ambiguous delivery",async()=>{
    const first=connection(),second=connection();first.submit.mockRejectedValueOnce(new Error("delivery unknown"));
    await new XrplPaymentAdapter({XRPL_ENABLED:"true"},vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),()=>{}).submitSigned(blob,1254);
    expect(first.submit).toHaveBeenCalledWith(blob);expect(second.submit).toHaveBeenCalledWith(blob);
  });
});
