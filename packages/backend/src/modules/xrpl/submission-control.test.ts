import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Wallet} from "xrpl";
import {submissionAvailability,assertSubmissionAllowed} from "./submission-control";
import {XrplPaymentAdapter} from "./payment-adapter";
let directory:string,path:string;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),"amma-xrpl-control-"));path=join(directory,"control.json");});
afterEach(()=>{try{unlinkSync(path);}catch{}rmdirSync(directory);});
const env=()=>({XRPL_ENABLED:"true",XRPL_PAYMENTS_ENABLED:"true",XRPL_SUBMISSION_CONTROL_FILE:path});
describe("fail-closed operator submission control",()=>{
  it("does not enable submission without both flags and a readable explicit control",()=>{
    expect(submissionAvailability({}).code).toBe("XRPL_PAYMENTS_DISABLED");
    expect(submissionAvailability(env()).code).toBe("XRPL_CONTROL_UNAVAILABLE");
    expect(submissionAvailability({...env(),XRPL_SUBMISSION_CONTROL_FILE:"relative.json"}).available).toBe(false);
    expect(submissionAvailability({...env(),XRPL_SUBMISSION_CONTROL_FILE:directory}).available).toBe(false);
  });
  it.each(['{}','null','[]','{"schemaVersion":1,"paused":"false"}','{"schemaVersion":2,"paused":false}','{"schemaVersion":1,"paused":false,"seed":"forbidden"}',"x".repeat(257)])("rejects malformed, ambiguous and oversized controls",input=>{
    writeFileSync(path,input);expect(()=>assertSubmissionAllowed(env())).toThrow("XRPL_CONTROL_UNAVAILABLE");
  });
  it("rereads pause/resume changes without a process restart",()=>{
    writeFileSync(path,JSON.stringify({schemaVersion:1,paused:true}));expect(()=>assertSubmissionAllowed(env())).toThrow("XRPL_SUBMISSION_PAUSED");
    writeFileSync(path,JSON.stringify({schemaVersion:1,paused:false}));expect(submissionAvailability(env())).toEqual({available:true,code:"AVAILABLE"});
    writeFileSync(path,"partial");expect(()=>assertSubmissionAllowed(env())).toThrow("XRPL_CONTROL_UNAVAILABLE");
  });
  it("rechecks the control at the actual RPC boundary after anchoring the connection",async()=>{
    writeFileSync(path,JSON.stringify({schemaVersion:1,paused:false}));
    const source=Wallet.generate(),dest=Wallet.generate();
    const signed=source.sign({TransactionType:"Payment",Account:source.classicAddress,Destination:dest.classicAddress,Amount:"1",Fee:"12",Sequence:1,LastLedgerSequence:1254});
    const client={connect:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{}),submit:vi.fn(),request:vi.fn(async(request:{command:string})=>{
      if(request.command==="server_info")return {result:{info:{network_id:1,server_state:"full",validated_ledger:{seq:1234,hash:"A".repeat(64),age:1}}}};
      writeFileSync(path,JSON.stringify({schemaVersion:1,paused:true}));
      return {result:{validated:true,ledger_index:1234,ledger_hash:"A".repeat(64),ledger:{close_time:Math.floor(Date.now()/1000)-946684800-1}}};
    })};
    await expect(new XrplPaymentAdapter(env(),()=>client).submitSigned(signed.tx_blob,1254)).rejects.toThrow("XRPL_SUBMISSION_PAUSED");
    expect(client.submit).not.toHaveBeenCalled();expect(client.disconnect).toHaveBeenCalledOnce();
  });
});
