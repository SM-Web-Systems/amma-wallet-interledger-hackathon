# Release A contract: native XRP on XRPL Testnet

Contract version: `1`. Implementation baseline for server review; changes must be recorded here before dependent milestones land. This is a design contract, not documentation of endpoints already implemented.

## Chain identity and backwards compatibility

Use `chain: "stellar" | "xrpl"` explicitly. Stellar network values remain `public` and `testnet`; XRPL network values are `mainnet` and `testnet`, but Release A accepts only XRPL Testnet. Never globally rename Stellar `public`, change STELLAR_NETWORK, or derive chain identity from a token ticker or an address prefix alone.

New XRPL operations use an `/api/v1/xrpl` namespace and fail closed when the feature is disabled. Proposed server settings: `XRPL_ENABLED=false`, `XRPL_NETWORK=testnet`, and operator-configured trusted TLS RPC endpoint(s). The frontend has its own disabled-by-default visibility flag; hiding UI is not server authorization. Mainnet XRPL configuration must fail startup validation when the feature is enabled in Release A. Reject client-supplied RPC URLs.

Existing Stellar APIs retain their current defaults. Add `chain=stellar` to existing wallet lookups/activation/signing/setting-mode paths before permitting XRPL records. A legacy active-wallet lookup must never select an XRP wallet. Scope new identities and indexes by `(user_id, chain, network, address)` and transaction hashes by `(chain, network, hash)`. Retain legacy wallet IDs and `publicKey` fields; map classic XRPL addresses into the public wallet identifier field at the adapter boundary, not raw hex signing public keys.

Wallet list calls without a chain filter continue to expose Stellar wallets only. Explicit chain-aware queries serve the new UI. Keep active wallet selection per user/chain/network; activation uses a transaction plus per-user locking to avoid concurrent active-wallet races. Legacy uniqueness constraints that prohibit equal addresses across networks must be replaced in a reviewed migration, with duplicate/conflict preflight checks. Confirm actual server constraints before writing that migration.

Legacy unqualified history/cache/portfolio code remains Stellar-only. Add chain/network metadata and scope contact/history writes and reads where they become shared. Do not reuse Stellar token/portfolio totals for XRP. Existing contacts lacking a network require a documented legacy policy before backfill; do not guess network from their address. Historical transaction network provenance must come from known ingestion configuration or be explicitly unknown and excluded from XRPL queries.

## Custody and recovery

XRP wallets use client-side signing regardless of the user's existing global Stellar `signingMode`. Release A rejects server-side signing and never stores an XRPL seed, raw private key or mnemonic on the backend, including in encrypted form. The backend stores only public wallet metadata and signed transaction evidence.

Recovery formats: a BIP-39 recovery phrase (12 or 24 words, the default for new wallets) derived at `m/44'/144'/0'/0/0` with secp256k1, the path Ledger, Xaman and most XRP wallets use; or an XRPL base58 family seed (Ed25519 for new family-seed wallets; SDK-recognized Ed25519/secp256k1 seeds on import), with address round-trip verification for both. The vault records the format as `keyFormat` (`bip39-mnemonic` or `xrpl-family-seed`) and binds it into the AES-GCM AAD. Published vectors: `abandon ×11 about` → `rHsMGQEkVNJmpGWs8XUBoTBiAAbwxZN5v3` (see `packages/web-app/src/lib/xrpl/vault.test.ts`). Arbitrary private-key, regular-key and multisign import remain out of scope. Added in PR #77 (audit F-8). Stellar mnemonic recovery is unchanged.

Use a versioned browser-local encrypted vault in IndexedDB, separate from Zustand's persisted public metadata. Minimum existing encryption parameters: PBKDF2-SHA256, 600,000 iterations, fresh random 16-byte salt, AES-256-GCM with a fresh random 12-byte IV. Bind vault version, wallet identity, chain, network and key format using authenticated additional data. Do not reuse a legacy decrypt helper that assumes Stellar secret length without checking XRP seed lengths. The PIN is never transmitted for XRP. A short PIN is not strong protection against offline attacks on a stolen vault; show backup guidance and use a stronger unlock secret policy for this vault.

Require explicit backup acknowledgement and a recovery/address check before marking a new wallet ready to send. Reload requires local vault unlock. Another device or cleared storage requires seed import; server login does not recover a seed. Unlock verifies the seed-derived address against metadata. Lock on logout, account/network switch and inactivity; clear accessible key references after each signing operation. JavaScript cannot guarantee erasure of all memory copies; do not claim otherwise. Raw material never enters telemetry, logs, URLs or persistent plaintext state.

Milestone 4 implementation: version 1 IndexedDB vaults use a separate 12–128 character local passphrase (digits-only/whitespace-only rejected), PBKDF2-SHA256 at 600,000 iterations and AES-256-GCM. Verification returns only public metadata; keys are not kept unlocked between actions. Hidden tabs, five-minute inactivity, account selection and logout clear drafts. Public-only XRP routes require personal JWT sessions and reject API-key callers and extra registration fields. See `MILESTONE_4.md` for the format, recovery procedure and remaining deployment gates.

## Adapter boundaries

The server adapter accepts no private material and returns exact string amounts. Milestone 3 implements reads in `packages/backend/src/modules/xrpl/read-adapter.ts`; Milestone 5 adds `payment-adapter.ts` for signed submission and `payment-service.ts` for persisted preparation/status. Conceptual boundary:

```ts
type XrplContext = { chain: "xrpl"; network: "testnet" };
type AccountSnapshot = XrplContext & {
  address: string;
  funded: boolean;
  balanceDrops: string;
  reserveDrops: string;
  spendableDrops: string;
  sequence: number | null;
  validatedLedgerIndex: number;
};

interface XrplReadAdapter {
  getAccount(address: string): Promise<AccountSnapshot>;
  getFee(): Promise<{ feeDrops: string; validatedLedgerIndex: number }>;
  lookupTransaction(hash: string): Promise<TransactionObservation>;
}
// Milestone 5; deliberately separate from the read adapter.
interface XrplPaymentAdapter extends XrplReadAdapter {
  submitSigned(blob: string, lastLedgerSequence: number): Promise<{ provisionalResult: string }>;
}
```

Preparation and observation fields follow the definitions below; the payment service coordinates preparation and persistence. SDK exceptions are mapped to stable application errors; no RPC response is treated as authoritative before validation. History gap/lookup failure yields unresolved status, not expiry. The client adapter owns create/import/unlock, transaction decode/preview comparison and signing. The server constructs no unrestricted signing endpoint.

## Payment-intent schema

All object schemas reject unknown properties. IDs are canonical decimal strings for database bigint identifiers; intent IDs are UUIDs. XRP values are integer drops in canonical positive decimal strings (`^[1-9][0-9]*$`), bounded against protocol limits with bigint arithmetic. No exponent, decimal-point, leading-zero or floating-point representation. Responses use the same units.

Create request (`POST /api/v1/xrpl/payment-intents`):

```json
{
  "schemaVersion": 1,
  "walletId": "123",
  "chain": "xrpl",
  "network": "testnet",
  "destination": "<checksum-valid classic XRPL address>",
  "destinationTag": 0,
  "amountDrops": "1000000",
  "maxFeeDrops": "100",
  "reference": "<opaque UUID>"
}
```

`destinationTag` is optional UInt32, 0 through 4294967295; zero is distinct from absent. Require it when destination account settings require a tag. Accept classic addresses only initially; reject X-addresses with an actionable message rather than silently discarding embedded tags. Reject self-payments and unsupported account signing configurations for the initial flow. `reference` is required, opaque, non-sensitive and unique per requesting application/user/network. No clinical, dataset or personal data in references or memos.

Require `Idempotency-Key` (UUID). Uniqueness is scoped by authenticated user, application identity when present, chain and network. Compare a canonical hash of the validated request body: same key/body returns the same intent, different body returns 409. Retries do not reallocate a sequence or sign a second transaction. Keep records for the complete reconciliation and receipt-retention lifetime; no automatic purge of unresolved payments.

Intent response includes schemaVersion, UUID id, public wallet ID, source address, chain/network, request fields, state, createdAt and updatedAt (UTC RFC3339). Owner and application IDs come from verified server context, never the body. The requested `maxFeeDrops` is capped by server policy, not trusted as an unlimited allowance. No platform fee is charged on XRP in Release A.

Browser approval preparation (`POST /payment-intents/{id}/prepare` under the namespace) is owner-JWT-only and locks the intent/account transactionally. It returns an immutable unsigned transaction, `preparationId`, canonical transaction digest, actual fee, sequence, LastLedgerSequence and ledger observation. Only one nonterminal preparation per owner/source/network is allowed initially. Because public registration does not prove key control, an unsigned preparation cannot reserve another owner's source globally. A verified source signature is required before acquiring the single global signed/submitted reservation for that source/network. Preparation retries return the existing preparation. Approval is the user's explicit confirmation of this exact preview followed by local signing, not a caller-supplied `approved=true` flag.

Before signing, the browser decodes the prepared transaction and compares every permitted field to the displayed intent and preparation; the server makes the same comparison when accepting the signed blob. Changing any value requires a new preparation and fresh approval, and a previous signed attempt must first be definitively resolved.

## Transaction restrictions and persistence

Accept only a direct native-XRP `Payment`: source, destination, exact amount, optional tag, fee, sequence, LastLedgerSequence and one server-defined opaque reference memo. Permit only the canonical-signature flag when applicable; reject partial payments and all other flags. No SendMax, DeliverMin, Paths, Tickets, AccountTxnID, Delegate, regular-key override, signer list, extra memos or unexpected fields. Normalize the SDK/API version's Amount/DeliverMax naming at one boundary; never accept two conflicting representations.

The signed blob endpoint (`POST /payment-intents/{id}/submit`) requires owner JWT, preparationId and transaction blob (bounded hex string). Verify signature and the signing public key's relationship to the approved source; validate every field against the preparation. Reject unsupported master-disabled/regular-key/multisign configurations. Derive the hash server-side. Persist signed blob, hash, sequence, ledger bound and reference atomically before any broadcast. Signed blobs are not seeds, but they are broadcastable authorizations: restrict access and redact them from ordinary logs.

Crash recovery workers resume persisted submissions. Re-broadcast only the exact saved blob while valid. An HTTP timeout is not a final ledger result. Track the last processed ledger and endpoint history coverage. Mark expiry only after the ledger bound has passed and authoritative lookup over sufficient history establishes non-inclusion. Testnet resets/history loss leave the attempt unresolved and require explicit reconciliation; never infer non-payment just because a server returns not-found.

Manual signer sequence coordination cannot stop someone using the same seed in another app. Treat external sequence consumption as a reconciliation event; do not silently re-sign. A compromised self-custody client can broadcast directly outside Amma; server intent controls restrict Amma's API and receipts, not the user's keys across the whole ledger.

## State and receipt schema

States: `awaiting_approval`, `prepared`, `signed`, `submitted`, `validated_success`, `validated_failure`, `expired`, `cancelled`. Persist a transition audit. `signed` is the durable boundary after accepted blob storage, not a browser-only event. Cancellation is permitted only before signed material may exist; a prepared attempt must retain its sequence reservation until safe expiry/non-inclusion, even if the user abandons it. Timeouts preserve the existing state and record a retryable observation. Validated states and proven expiry are terminal. A ledger-success transaction that fails intent comparison is an integrity incident and must not issue a successful receipt.

Milestone 5 implements all states above except `expired`, which requires Milestone 6 history-coverage evidence. It includes the minimum durable signed-blob, idempotency and verified-source coordination boundary before any live broadcast. Successful receipts require exact validated `tesSUCCESS`; validated failures must be `tec` results. Integrity incidents remain quarantined through ordinary retries/status checks. Polling and manual same-blob retries are implemented; restart workers and authoritative expiry are not. Payment APIs/UI require separate disabled-by-default flags. See `MILESTONE_5.md` for evidence and migration gates.

Milestone 6 adds the `expired` state, a disabled-by-default recovery worker, fenced database leases, bounded persisted same-blob retries and complete-history reconciliation. Expiry requires matching original/progress ledger hashes, a passed ledger bound, continuous history and unchanged source sequence at the bound/current ledger; saved hashes also require `searched_all=true`. Unsigned preparations require complete account-history scanning. Checkpoint drift, external sequence consumption, integrity conflicts and transaction binding conflicts remain held for review. A stale endpoint alone does not prove a reset. See `MILESTONE_6.md` for exact evidence, configuration and migration/rollback limits. No automatic replacement/signature or unconditional unfreeze endpoint exists.

Successful receipt (`GET /payment-intents/{id}/receipt`):

```json
{
  "schemaVersion": 1,
  "intentId": "<UUID>",
  "chain": "xrpl",
  "network": "testnet",
  "transactionHash": "<64 uppercase hex characters>",
  "ledgerIndex": 12345,
  "ledgerHash": "<64 uppercase hex characters>",
  "validated": true,
  "result": "tesSUCCESS",
  "source": "<classic address>",
  "destination": "<classic address>",
  "destinationTag": 0,
  "currency": "XRP",
  "deliveredAmountDrops": "1000000",
  "feeDrops": "12",
  "reference": "<opaque UUID>",
  "verifiedAt": "2026-10-28T12:00:00Z"
}
```

Receipt fields derive from ledger evidence, not client assertions. Require `validated=true`, `tesSUCCESS`, Payment type, exact source/destination/tag/reference and exact native delivered amount; fees must match preparation and remain within the ceiling. Fee-charging failed transactions are not payment receipts. An unresolved or failed intent returns no success receipt. A provider verifies these fields through its own trusted XRPL connection; the JSON is an application observation, not a cryptographic proof of settlement.

Single-use receipt claims (`POST /payment-intents/{id}/claims`) bind a unique transaction `(chain, network, hash)` and intent/reference to one opaque external purchase ID and authorized application. Atomically persist the claim. Same caller/purchase is idempotent; a second purchase or caller is rejected. Do not claim this prevents fulfilment replay in an external provider's database: providers must enforce their own equivalent transaction/reference uniqueness.

## Authorization and errors

First-party browser requests require a user JWT and explicit wallet ownership. For new XRP routes require the user token type explicitly. External create/status/receipt/claim calls additionally require a valid active DB-backed tenant key, explicit new XRP scope, tenant membership and binding to that user/application. Implemented scopes: `xrpl:payments:create`, `xrpl:payments:read`, `xrpl:receipts:claim`. Legacy env keys and DB-outage fallbacks cannot satisfy these scopes. Never alter legacy LMS behavior to enforce this; add a strict new-route guard. API keys alone never authorize prepare or submit. No API-key credential embedded in the browser.

Stable error shape: `{ "error": { "code": "...", "message": "...", "retryable": false } }` with a request correlation ID. Use 400 for invalid schema, 401 for authentication failure, 403 for unauthorized scope/action, 404 for missing/not-owned resource, 409 for idempotency/state conflict, 422 for payment policy/account rejection, 429 for throttling and 503 for unavailable/disabled network service. Errors never imply a submitted payment definitely failed. Expected codes include `XRPL_DISABLED`, `NETWORK_NOT_ALLOWED`, `INVALID_ADDRESS`, `TAG_REQUIRED`, `INSUFFICIENT_SPENDABLE_BALANCE`, `FEE_LIMIT_EXCEEDED`, `IDEMPOTENCY_CONFLICT`, `PAYMENT_UNRESOLVED`, `RECEIPT_UNAVAILABLE`, `RECEIPT_ALREADY_CLAIMED` and `UNSUPPORTED_SIGNING_CONFIGURATION`.

## Migration/deployment gate

Milestone 2 must validate the actual server schema/journal against checked-in migrations before generating another migration. Do not run the historical migration chain blindly against a database previously managed with schema push. Use additive migrations with a schema fingerprint/precondition and a versioned migration runner packaged in a dedicated image/target; do not mutate the production runtime image interactively. Include rollback-compatible reader behavior. Keep XRPL feature flags off until the complete payment acceptance suite passes.

## Acceptance evidence required later

Round-trip recovery; short-seed encryption/decryption; field-tampering rejection; cross-user/tenant denial; legacy-key scope bypass rejection; duplicate-submit/concurrent-sequence recovery; restart-before/after-broadcast; validated-failure and history-gap handling; tag zero; receipt claims; existing Stellar/LMS regression checks. Run against real routes/services and a disposable DB, plus genuine Testnet settlement. This document is not evidence that these properties already hold.

Official protocol references checked for this contract:

- https://js.xrpl.org/classes/Wallet.html
- https://xrpl.org/docs/references/protocol/transactions/types/payment
- https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission


## Milestone 7 implementation

External operations now require the strict DB-backed key plus personal user JWT and `tenant_users` membership described above. One active, unsuspended tenant is one application identity; rotating keys share it. Environment keys/wildcards/outage fallbacks cannot satisfy these scopes. API-key callers can create/read only their own application/user intents and claim exact successful receipts. Owner-only prepare/submit/retry/cancel/list routes still reject keys. Existing Stellar/LMS behavior is unchanged.

The served contract is `/api/v1/xrpl/openapi.json`, version 1.0.0; an offline copy is `openapi.v1.json`. External status omits unsigned preparation and embedded receipt. The response includes an application name/tenant snapshot and a relative owner-approval path containing only wallet/intent selectors. Links survive login and never auto-prepare/sign or carry a callback or credential. Expected terms always come from the saved owner-authorized intent. New integration access is disabled by default.

Application identity participates in user/network idempotency and reference indexes; historical personal requests retain null scope. Claims require `schemaVersion:1`, the exact UUID reference and uppercase transaction hash, and one opaque purchase UUID. Insert plus audit event is atomic; intent, hash, reference and tenant-purchase uniqueness apply. An identical same-tenant/user/purchase retry returns the same claim even after key rotation. A second purchase or reuse of a consumed tenant purchase is rejected. No unclaim or automatic purge is exposed. Consumer-side uniqueness and fulfilment authorization remain mandatory.

`MILESTONE_7.md` records the additive migration, strict scopes and operations, independent verifier example, real browser/Testnet settlement and claim evidence, and remaining server gates. Enable durable recovery for staging payment acceptance. Run compatible M7 readers after application records exist; disabling flags preserves evidence, while an older financial-service rollback is unsafe.


## Milestone 8 operational boundary

An operator-owned read-only mounted control file is now required for submission, independently of feature flags. Its paused JSON is `{"schemaVersion":1,"paused":true}`; an authorized resume uses the boolean `false`; missing/invalid control fails closed. API preparation/admission/manual retry and each actual SDK broadcast recheck it. The owner UI checks `/api/v1/xrpl/payment-availability` before local signing and keeps saved outcome reads available under the file pause. This cannot revoke an already signed/transmitted transaction or an owner's external seed use. No API caller can unpause the operator file.

Each prepare/submit/rebroadcast route uses a five-per-minute verified-user signing limit. Caller-selected API-key headers cannot reset it or authorize signing. Private internal-admin aggregate health/queue monitoring emits structured alerts; actual operator delivery and distributed rate limiting remain deployment responsibilities. See `MILESTONE_8.md` for bounded monitoring, error redaction, revision/schema preflight, migration/rollback order and the retained independent server release gate. The external intent/receipt/claim format and mandatory manual approval are unchanged.
