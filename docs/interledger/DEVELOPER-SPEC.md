# Developer spec

Implemented behaviour is described in `README.md` (Codex's implementation notes). The API is in `API.md`,
the partner model in `PARTNER_GATEWAY.md` and `EXCHANGES.md`, and the gates in `ACCEPTANCE.md` and `VERIFICATION.md`.
This file records the contracts the review relies on and the changes made during the handoff run.

## Money and ledger invariants (implemented, tested)

- Amounts are non-negative integer strings of up to 78 digits, held as `bigint`. Decimal input is parsed
  with an explicit scale. There is no floating point in the payment module.
- Asset identity is `chain:network:code:issuer|native:scale`. Stellar is scale 7, and XRPL is native XRP at scale 6, Testnet only.
- Every ledger row is one balanced debit/credit pair in one asset. The rows are append-only (enforced by a trigger),
  references are unique, and a replay must match exactly.
- Customer and reserved balances can't go negative (CHECK, plus a conditional UPDATE). Clearing and fees accounts may.
- Approval is bound to the quote hash. There's one execution per quote and one active execution per invoice. Daily and
  per-payment limits are applied per full asset identity.

## Funding-leg states

`planned → prepared → submitted → confirmed | failed | unknown`. A leg in `unknown` blocks recovery
until it's proven. Stellar now proves `failed` only on a Horizon 404 together with a closed ledger after
the transaction's `maxTime` (`ccc6880`).

## Schema ownership

Tables created by guarded SQL migrations are excluded from `drizzle-kit push` via
`tablesFilter` (`5f22111`). A regression test fails if a new raw-SQL table is exposed.
`interledger-payments-v1` is recorded in `amma_chain_migrations` with its checksum (`200cee9`).

## Proposed (not implemented)

- A lease-based job claim for payment workers, so no DB transaction is held across network calls.
- Partner corridors (VALR first), enabled only after account-level verification.
