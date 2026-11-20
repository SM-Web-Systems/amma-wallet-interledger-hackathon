// Versioned, dependency-free contract also served at /api/v1/xrpl/openapi.json.
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const uuid={type:"string",pattern:"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"};
const hash={type:"string",pattern:"^[A-F0-9]{64}$"};
const address={type:"string",minLength:25,maxLength:35,description:"Checksum-valid classic XRPL address; X-addresses rejected."};
const drops={type:"string",pattern:"^(?:[1-9][0-9]{0,16}|100000000000000000)$",description:"Integer drops, at most 100000000000000000; 1 XRP = 1000000 drops."};
const tag={type:"integer",minimum:0,maximum:4294967295};
const time={type:"string",format:"date-time"};
const context={schemaVersion:{const:1},chain:{const:"xrpl"},network:{const:"testnet"}};
const input={...context,walletId:{type:"string",pattern:"^[1-9][0-9]{0,14}$"},destination:address,destinationTag:tag,amountDrops:drops,maxFeeDrops:{type:"string",pattern:"^(?:[1-9][0-9]{0,2}|1000)$",description:"1 to 1000 drops, capped by server policy."},reference:uuid};
const requiredInput=Object.keys(input).filter(key=>key!=="destinationTag");
const object=(properties:Record<string,unknown>,required=Object.keys(properties))=>({type:"object",additionalProperties:false,properties,required});
const json=(schema:unknown)=>({"application/json":{schema}});
const response=(schema:unknown,description="Success")=>({description,content:json(schema)});
const errors=Object.fromEntries([400,401,403,404,409,413,422,429,503].map(code=>[String(code),response(ref("Error"),`HTTP ${code}; inspect error.code and retryable. Unavailability never proves non-payment.`)]));
const id={name:"id",in:"path",required:true,schema:uuid};
const key={name:"Idempotency-Key",in:"header",required:true,schema:uuid,description:"Scope: user + application tenant + XRPL Testnet. Same body replays; conflicting reuse is 409."};
const body=(schema:unknown)=>({required:true,content:json(schema)});
const base="/api/v1/xrpl/payment-intents";
const operation=(operationId:string,scope:string|undefined,schema:unknown,request?:unknown)=>({operationId,
  ...(scope?{"x-required-application-scope":scope}: {security:[{UserSession:[]}]}),
  parameters:[id],...(request?{requestBody:body(request)}:{}),responses:{"200":response(schema),...errors}});
const receipt=object({...context,intentId:uuid,transactionHash:hash,ledgerIndex:{type:"integer",minimum:1},ledgerHash:hash,validated:{const:true},result:{const:"tesSUCCESS"},source:address,destination:address,destinationTag:tag,currency:{const:"XRP"},deliveredAmountDrops:drops,feeDrops:drops,reference:uuid,verifiedAt:time},[...Object.keys(context),"intentId","transactionHash","ledgerIndex","ledgerHash","validated","result","source","destination","currency","deliveredAmountDrops","feeDrops","reference","verifiedAt"]);
const status=object({...input,id:uuid,ownerId:{type:"string",pattern:"^[1-9][0-9]*$"},source:address,
  state:{enum:["awaiting_approval","prepared","signed","submitted","validated_success","validated_failure","expired","cancelled"]},
  transactionHash:{anyOf:[hash,{type:"null"}]},resultCode:{type:["string","null"]},lastObservation:{type:["string","null"]},
  application:{anyOf:[object({tenantId:{type:"string",pattern:"^[1-9][0-9]*$"},name:{type:"string",minLength:1,maxLength:120}}),{type:"null"}]},
  approvalPath:{type:"string",pattern:"^/xrpl\\?walletId=[1-9][0-9]*&intentId=[0-9a-f-]+$",description:"Append to your configured trusted Amma frontend origin. No credential or automatic approval is conveyed."},createdAt:time,updatedAt:time},[...requiredInput,"id","ownerId","source","state","transactionHash","resultCode","lastObservation","application","approvalPath","createdAt","updatedAt"]);
export const xrplIntegrationOpenApi={openapi:"3.1.0",info:{title:"Amma XRP Testnet integration",version:"1.0.0",description:
  "Release A native XRP, explicit browser approval only. External operations require BOTH the payer's short-lived personal JWT and an active database tenant key with the exact scope, active unsuspended tenant and tenant_users membership. One tenant is one application boundary; rotating keys retain access. No env keys, wildcard scopes or DB-outage fallback. Keep keys server-side. An API key never authorizes prepare/submit/rebroadcast/cancel. Existing first-party personal JWT routes also serve owners without an API key. External status omits unsigned preparation and receipt; fetch the receipt separately. Pending/timeout is never settlement. Rate limits are per process; deployment must enforce shared limits before scaling."},
  servers:[{url:"/",description:"Use the operator-configured trusted Testnet API origin."}],security:[{UserSession:[],ApplicationKey:[]}],
  paths:{
    [base]:{post:{...operation("createXrpIntent","xrpl:payments:create",ref("PaymentStatus"),ref("PaymentInput")),parameters:[key],description:"Creates a request only. Open approvalPath on the trusted Amma frontend; the user must review and sign locally. Never send keys, passphrases or approved=true."}},
    [`${base}/{id}`]:{get:operation("getXrpIntent","xrpl:payments:read",ref("PaymentStatus"))},
    [`${base}/{id}/receipt`]:{get:operation("getXrpReceipt","xrpl:payments:read",ref("Receipt"))},
    [`${base}/{id}/claims`]:{post:{...operation("claimXrpReceipt","xrpl:receipts:claim",ref("Claim"),ref("ClaimInput")),description:"Atomically consumes a validated receipt for one opaque purchase UUID. Same tenant/user/intent/purchase retry is idempotent, including key rotation. A second purchase, transaction, or payer cannot reuse it. A tenant purchase ID is single-use across payers. Verify settlement independently before fulfilment; enforce equivalent uniqueness in the consumer database."}},
  },
  components:{securitySchemes:{UserSession:{type:"http",scheme:"bearer",bearerFormat:"JWT",description:"Personal user access JWT obtained by the existing Amma authentication flow. Admin, refresh and SSO token types rejected."},ApplicationKey:{type:"apiKey",in:"header",name:"X-API-Key",description:"DB-backed tenant key with the operation's exact x-required-application-scope."}},schemas:{
    PaymentInput:object(input,requiredInput),PaymentStatus:status,Receipt:receipt,
    ClaimInput:object({schemaVersion:{const:1},reference:uuid,transactionHash:hash,purchaseId:uuid}),
    Claim:object({...context,id:uuid,intentId:uuid,applicationTenantId:{type:"string",pattern:"^[1-9][0-9]*$"},transactionHash:hash,reference:uuid,purchaseId:uuid,claimedAt:time}),
    Error:object({error:object({code:{type:"string"},message:{type:"string"},retryable:{type:"boolean"},requestId:{type:"string"}})}),
  }}
};
