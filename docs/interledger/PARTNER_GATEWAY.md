# Partner gateway contract and release evidence

`PartnerGateway` calls an Amma-operated integration gateway. These endpoints are
not claims about TDME/FiveWest endpoint names or payload formats. Implement the
vendor-specific mapping only after receiving the enabled account's API contract.
All requests use a server-only bearer token over HTTPS with redirects disabled.
Route and conversion references must survive retries and process restarts.

## Endpoints

`POST /v1/routes` receives `{source,target}`. Return `{routes:[...]}` containing
route ID, capacity, source units per receive unit as integer `numerator` and
`denominator`, fixed source `fee`, independent source-to-target valuation ratio,
expiry and opaque provider evidence. Capacity and prices must be executable, not
indicative. All network/provider/FX/Amma fees must be represented. Maximum eight
routes per source; the planner's total route limit is sixteen.

`POST /v1/conversions/prepare` receives `{clientReference,route,source,target,
receive,maxDebit}`. Idempotently reserve/refresh a conversion within that cap.
Return `receive`, `maxDebit`, `targetAssetKey` and, for native XRP funding,
`depositAddress` plus optional `destinationTag`. These values are checked against
the user's approval. Deposit instructions must use XRPL Testnet in Release A.
The gateway must validate quote ownership, amount, network, permitted custody and
destination. Its response must not require a client secret or seed.

`POST /v1/conversions/observe` receives `{clientReference,proof?}`. For XRP, `proof`
is Amma's independently reconciled native-XRP receipt. The gateway must independently
verify the credited deposit and execute only the previously authorized conversion.
Return `{state,reference,received?,assetKey?,evidence?}` where state is pending,
confirmed, failed, or unknown. Confirmed means the exact target amount is backed
and available in the agreed treasury/custody account. Repeated observation must
never execute another conversion or spend beyond the approved caps.

If preparation or conversion has already collected funds, a failed downstream
payment must leave those funds recoverable in the actual held asset. A gateway
must not report a temporary lookup failure as definitive failure. Conversion
settlement and provider bank withdrawal states need separate persisted records.

## Evidence required from TDME / FiveWest

- Exact enabled products and legal/customer-account model for Amma's arrangement.
- Sandbox API specification, authentication, idempotency lifetime, rate limits,
  quote ownership, expiry, execution, status and error semantics.
- Supported assets **and networks**, approved ZARC issuer, XRPL destination-tag
  rules, wallet whitelisting and applicable identity requirements.
- Verified XRP-to-target route, source confirmation policy, FX inventory and fees.
- Funding, conversion, partial failure, delayed settlement and withdrawal tests.
- Statements/reconciliation export and actual peer settlement arrangement.

Credentials belong in the runtime secret store. Do not paste them into a chat,
source file, screenshot or submitted hackathon folder. Vendor logos or existing
commercial relationships alone do not prove a usable conversion corridor.

## Concrete FiveWest API client

`fivewest.ts` implements the public profile/trading API contracts for token
authentication, fixed-receive RFQ, RFQ lookup, bounded acceptance, trade lookup,
and wallet balance reads. It parses JSON numeric lexemes exactly on Node 22,
rechecks the provider's RFQ against the original amount/currencies/cap, and does
not retry an ambiguous acceptance POST. RFQ acceptance is disabled unless the
client is explicitly constructed with verified execution capability.

Public FiveWest docs specify acceptance within less than ten seconds. The client
uses a conservative five-second local deadline; this does not guarantee a price
lock. Refresh the RFQ **after confirmed funding**, accept within the approved
source cap, and independently reconcile the trade and target balance. If the cap
cannot buy the approved receive amount, keep the funds recoverable and return for
review. Do not substitute an indicative FX rate or silently raise the cap.

The docs' generic base URL widgets and endpoint examples differ in places. The
client uses the service prefixes in the concrete examples: `/profile/api/v1`,
`/trading/api/v1`, and `/wallet/api/v1`; the actual sandbox origin is supplied by
the operator. No currency/network support, custody or withdrawal entitlement is
inferred from an RFQ currency pair. TDME and ZARC issuer verification remain pending.

Sources reviewed in a browser on 2026-10-31:

- https://docs.fivewest.co.za/api-authentication/authentication
- https://docs.fivewest.co.za/trading-api/rfq-api
- https://docs.fivewest.co.za/trading-api
- https://docs.fivewest.co.za/wallet-api/user-balance
