# Payments API

All paths below start with `/api/v1/payments`. Customer operations require an
authenticated personal Amma session. The backend derives ownership from that
session. Amounts are integer strings in the asset's scale; never send JavaScript
floating-point amounts. Assets include chain, network, code, issuer when issued,
and scale.

| Method and path | Purpose |
| --- | --- |
| GET `/availability` | Feature state, pause state and supported receiving assets |
| GET `/accounts` | Managed customer balances |
| GET `/sources` | Spendable external and managed sources, with exclusion reasons |
| GET, POST `/addresses` | List or provision an asset-specific receiving address |
| POST `/requests` | Create a merchant request and Rafiki incoming payment |
| POST `/requests/remote` | Resolve a supplier address into an incoming payment |
| GET `/requests/:id` | Read an opaque invoice without exposing its owner's ID |
| POST `/quotes` | Plan funding for `requestId`, with optional `excludedSources` |
| POST `/approvals` | Bind `quoteId` and its returned SHA-256 `hash` |
| GET `/executions/:id` | Funding, signing actions, payment and recovery status |
| POST `/executions/:id/signatures` | Submit `legId` and exact `signedTransaction` |
| POST `/executions/:id/recover` | Return confirmed recoverable funds; empty JSON body |
| GET `/executions/:id/receipt` | Receipt only after confirmed payment |
| GET `/history` | Owner's most recent 50 executions |
| GET, POST `/consent/:id/:nonce` | Review GNAP scope; submit `hash` and `approve` |
| GET `/grants` | List permissions captured through Amma consent. Each has `status`: `awaiting_client` (approved, client has not continued), `active`, `revoked`, `rejected`, or `unverified` (authorization server unreadable) |
| POST `/grants/:id/revoke` | Revoke a captured grant; empty JSON body |
| POST `/webhooks/rafiki` | Signed provider events; no customer JWT |

Use an `Idempotency-Key` UUID for address, request, remote request, quote and
approval creation. Reuse the same key and body when retrying an uncertain HTTP
response. A conflicting body returns HTTP 409. Signatures are bound to prepared
transactions; recovery and provider events have their own durable deduplication.
Network or partner failures do not authorize a replacement payment.

Quotes include exact recipient amount, source allocations, maximum source debits,
separate network fee ceilings, expiry, common-unit cost and a simulation flag.
Prepared execution legs include the signing actions. Approval cannot remove a
local wallet's cryptographic signing requirement.

Financial state transitions use the durable job table as the execution outbox;
provider notifications use the webhook inbox plus reconciliation jobs. A webhook
acknowledgement means durable receipt, not completed financial processing.
If notifications are lost, a periodic catch-up scan of the Admin API queues the
missed incoming payments (finished, with funds received) and unfunded outgoing
payments for the same jobs. The scan never posts to the ledger itself.
Authoritative Rafiki reads and ledger-confirmed funding determine the result.
