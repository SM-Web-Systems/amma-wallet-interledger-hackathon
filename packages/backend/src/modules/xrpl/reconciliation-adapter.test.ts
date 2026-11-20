import {describe,expect,it,vi} from "vitest";
import {Wallet,decode} from "xrpl";
import {XrplReconciliationAdapter,historyCovers,type AttemptInspection} from "./reconciliation-adapter";
import type {ReadRequest} from "./read-adapter";
import {TESTNET_ENDPOINTS} from "./config";

const source=Wallet.generate(),destination=Wallet.generate();
const signed=source.sign({TransactionType:"Payment",Account:source.classicAddress,Destination:destination.classicAddress,Amount:"1000000",Fee:"12",Sequence:12,LastLedgerSequence:120});
const A="A".repeat(64),B="B".repeat(64),C="C".repeat(64),D="D".repeat(64);
const attempt=():AttemptInspection=>({source:source.classicAddress,sequence:12,minLedger:100,anchorHash:A,lastLedgerSequence:120,hash:signed.hash});
const env={XRPL_ENABLED:"true",XRPL_RPC_URLS:TESTNET_ENDPOINTS[0]};
const missing=(request:ReadRequest,searched_all:unknown)=>Object.assign(new Error("private RPC detail"),{data:{error:"txnNotFound",searched_all,request}});
function fixture(change?:(request:ReadRequest,value:Record<string,unknown>)=>unknown,head=125){
  const request=vi.fn(async(req:ReadRequest)=>{
    let value:Record<string,unknown>;
    switch(req.command){
      case "server_info":value={info:{network_id:1,server_state:"full",complete_ledgers:"90-130",validated_ledger:{seq:head,hash:C,age:1}}};break;
      case "ledger":{const index=typeof req.ledger_index==="number"?req.ledger_index:head;value={validated:true,ledger_index:index,ledger_hash:index===100?A:index===120?B:index===110?D:C,ledger:{close_time:Math.floor(Date.now()/1000)-946684800-1}};break;}
      case "tx":value={};break;
      case "account_tx":value={account:source.classicAddress,ledger_index_min:100,ledger_index_max:120,validated:true,transactions:[]};break;
      case "account_info":value={validated:true,ledger_index:req.ledger_index??head,ledger_hash:req.ledger_index===120?B:C,account_data:{Account:source.classicAddress,Sequence:12}};break;
      default:value={};
    }
    const changed=change?.(req,value);
    if(req.command==="tx"&&(changed===undefined||changed===value))throw missing(req,true);
    return {result:changed??value};
  });
  const client={connect:vi.fn(async()=>{}),disconnect:vi.fn(async()=>{}),request,submit:vi.fn(async()=>({result:{engine_result:"tesSUCCESS"}}))};
  return {client,request,adapter:new XrplReconciliationAdapter(env,()=>client)};
}
const found=()=>({validated:true,hash:signed.hash,ledger_index:110,tx_json:decode(signed.tx_blob),meta:{TransactionResult:"tesSUCCESS",delivered_amount:"1000000"}});

describe("history-backed Testnet reconciliation",()=>{
  it.each([["90-130",true],["1-99,100-110,111-130",true],["90-110,110-125",true],["90-109,111-130",false],["100-119",false],["empty",false],["0-130",false],["90-4294967296",false],["90-130,bad",false]] as const)("checks complete-ledger coverage %s",(value,expected)=>{expect(historyCovers(value,100,120)).toBe(expected);});
  it("proves signed-attempt non-inclusion only after the bound with full search/history and unchanged source",async()=>{
    const f=fixture(),evidence=await f.adapter.inspectAttempt(attempt());
    expect(evidence).toMatchObject({status:"expired",code:"NON_INCLUSION_PROVEN",searchedAll:true,sequenceAtBound:12,currentSequence:12,pages:1,scanned:0,minLedger:100,maxLedger:120});
    expect(f.request.mock.calls.find(([r])=>r.command==="tx")?.[0]).toMatchObject({min_ledger:100,max_ledger:120,transaction:signed.hash});
    expect(f.client.submit).not.toHaveBeenCalled();
  });
  it("can expire an abandoned unsigned preparation without assuming its hash",async()=>{
    const f=fixture();expect(await f.adapter.inspectAttempt({...attempt(),hash:null})).toMatchObject({status:"expired",searchedAll:false});
    expect(f.request.mock.calls.some(([r])=>r.command==="tx")).toBe(false);
  });
  it.each([false,undefined,"true"])("does not infer non-inclusion from searched_all=%s",async searched=>{
    const f=fixture(req=>{if(req.command==="tx")throw missing(req,searched);});
    await expect(f.adapter.inspectAttempt(attempt())).rejects.toMatchObject({code:"HISTORY_UNAVAILABLE"});
  });
  it("keeps an open-ledger attempt open and never scans future history",async()=>{
    const f=fixture(undefined,119);expect(await f.adapter.inspectAttempt(attempt())).toMatchObject({status:"open",code:"AWAITING_LEDGER_BOUND"});
    expect(f.request.mock.calls.some(([r])=>r.command==="account_tx")).toBe(false);
  });
  it("never treats a disjoint complete-ledger range as sufficient",async()=>{
    const f=fixture((req,value)=>{if(req.command==="server_info")(value.info as any).complete_ledgers="90-109,111-130";return value;});
    await expect(f.adapter.inspectAttempt(attempt())).rejects.toMatchObject({code:"HISTORY_UNAVAILABLE"});
  });
  it("falls back to a complete endpoint rather than merging two endpoints' partial histories",async()=>{
    const incomplete=fixture((req,value)=>{if(req.command==="server_info")(value.info as any).complete_ledgers="90-109";return value;}),complete=fixture();
    const factory=vi.fn().mockReturnValueOnce(incomplete.client).mockReturnValueOnce(complete.client);
    expect(await new XrplReconciliationAdapter({XRPL_ENABLED:"true"},factory).inspectAttempt(attempt())).toMatchObject({status:"expired",endpoint:TESTNET_ENDPOINTS[1]});
  });
  it("quarantines a changed anchor instead of trying another endpoint or broadcasting",async()=>{
    const changed=fixture((req,value)=>req.command==="ledger"&&req.ledger_index===100?{...value,ledger_hash:D}:value);
    const factory=vi.fn(()=>changed.client);
    await expect(new XrplReconciliationAdapter({XRPL_ENABLED:"true"},factory).inspectAttempt(attempt())).rejects.toMatchObject({code:"LEDGER_RESET"});
    expect(factory).toHaveBeenCalledTimes(1);expect(changed.client.submit).not.toHaveBeenCalled();
  });
  it("does not interpret a reset head or missing historical anchor as expiry",async()=>{
    await expect(fixture(undefined,99).adapter.inspectAttempt(attempt())).rejects.toMatchObject({code:"STALE_LEDGER"});
    const absent=fixture(req=>{if(req.command==="ledger"&&req.ledger_index===100)throw Object.assign(new Error(),{data:{error:"lgrNotFound"}});});
    await expect(absent.adapter.inspectAttempt(attempt())).rejects.toMatchObject({code:"HISTORY_UNAVAILABLE"});
  });
  it("checks the saved progress checkpoint and refuses a changed validated hash",async()=>{
    const f=fixture();
    expect(await f.adapter.inspectAttempt({...attempt(),checkpoint:{index:121,hash:C}})).toMatchObject({status:"expired"});
    await expect(f.adapter.inspectAttempt({...attempt(),checkpoint:{index:121,hash:D}})).rejects.toMatchObject({code:"LEDGER_RESET"});
    await expect(f.adapter.inspectAttempt({...attempt(),checkpoint:{index:126,hash:C}})).rejects.toMatchObject({code:"STALE_LEDGER"});
  });
  it("recovers a prepared transaction discovered through fully paginated account history",async()=>{
    const f=fixture((req,value)=>{
      if(req.command==="account_tx")return req.marker?{...value,transactions:[{ledger_index:110,validated:true,hash:signed.hash,tx_json:decode(signed.tx_blob)}]}:{...value,marker:{page:2}};
      if(req.command==="tx")return found();return value;
    });
    expect(await f.adapter.inspectAttempt({...attempt(),hash:null})).toMatchObject({status:"validated",code:"RECOVERED_SEQUENCE_TRANSACTION",pages:2,transaction:{transactionHash:signed.hash,validated:true}});
  });
  it("holds a source whose sequence was consumed by another transaction",async()=>{
    const f=fixture((req,value)=>req.command==="account_tx"?{...value,transactions:[{ledger_index:110,validated:true,hash:D,tx_json:{Account:source.classicAddress,Sequence:12}}]}:undefined);
    expect(await f.adapter.inspectAttempt(attempt())).toMatchObject({status:"unresolved",code:"SEQUENCE_CONSUMED"});
    const changed=fixture((req,value)=>req.command==="account_info"?{...value,account_data:{Account:source.classicAddress,Sequence:13}}:undefined);
    expect(await changed.adapter.inspectAttempt(attempt())).toMatchObject({status:"unresolved",code:"SEQUENCE_CONSUMED"});
  });
  it.each(["repeated marker","page limit","unvalidated entry","wrong bounds","unvalidated bound"])("keeps %s unresolved",async mode=>{
    const f=fixture((req,value)=>{
      if(req.command==="account_tx"){
        if(mode==="repeated marker")return {...value,marker:{page:1}};
        if(mode==="page limit")return {...value,marker:{page:Number((req.marker as any)?.page??0)+1}};
        if(mode==="unvalidated entry")return {...value,transactions:[{validated:false,ledger_index:110,tx_json:{Account:source.classicAddress,Sequence:1}}]};
        if(mode==="wrong bounds")return {...value,ledger_index_min:101};
      }
      if(mode==="unvalidated bound"&&req.command==="account_info")return {...value,validated:false};return undefined;
    });
    await expect(f.adapter.inspectAttempt(attempt())).rejects.toMatchObject({code:"HISTORY_UNAVAILABLE"});
  });
  it("accepts validated hash evidence without requiring unrelated historical coverage",async()=>{
    const f=fixture((req,value)=>{if(req.command==="server_info")(value.info as any).complete_ledgers="empty";if(req.command==="tx")return found();return value;});
    expect(await f.adapter.inspectAttempt(attempt())).toMatchObject({status:"validated",transaction:{resultCode:"tesSUCCESS",transactionHash:signed.hash}});
  });
});
