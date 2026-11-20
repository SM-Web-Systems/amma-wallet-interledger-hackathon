# Verification and remaining acceptance

This is an isolated checkout based on the existing XRP Testnet candidate. The
payment feature and submissions default to disabled. No migration, payment,
partner trade, deployment, or external submission was performed.

## Local evidence

- Payment service, planner, ledger, provider-event, signing, consent, FiveWest
  client and API tests use mocked providers and a PostgreSQL-compatible PGlite
  database. The GraphQL operations are validated against the vendored,
  unmodified schema of Rafiki v2.4.2-beta.
- The browser checkout was exercised using fixture responses: a shop invoice,
  two funding sources, approval, simulated settlement and receipt. This proves
  the UI flow only; it is not a real ledger or Interledger transaction.
- Existing backend and frontend suites were run. Initial localhost socket
  failures under the sandbox passed when those files were rerun with localhost
  access. The web production bundle builds; the existing development optimizer
  has a `stellar-hd-wallet` error.
- The source candidate already has backend TypeScript errors. Run `npx tsc
  --noEmit` and compare payment-related diagnostics separately. The backend
  `build` script is a placeholder, not a TypeScript check.
- The production dependency audit identifies existing high-severity transitive
  issues in the Stellar wallet dependency chain. These require a compatible
  upstream dependency update and security review before a production pilot.

## External acceptance still needed

Docker was unavailable, so the two-peer Compose configuration has not been
started and image availability, startup, provisioning and networking remain to
be demonstrated. A real end-to-end test requires TLS hosts, the private
provider keys, funded Stellar and XRP Testnet accounts, and a verified partner
gateway. The public FiveWest client is not wired to execute a custody or FX
corridor until account entitlements and settlement semantics are confirmed.
TDME must supply the approved ZARC issuer and relevant sandbox arrangements.

Provider reconciliation covers created merchant requests and reserved outgoing
payments. A catch-up scan (`ProviderEvents.catchUp`, every
`PAYMENTS_CATCHUP_INTERVAL_MS`, default 5 minutes) covers lost notifications: it
lists recent incoming payments on every Amma wallet address and unfunded
outgoing payments, and queues any that no job or ledger posting covers. It only
queues work; the worker still reads Rafiki before money moves. It is unit-tested
with a mocked Admin API and has not yet run against live Rafiki peers. A
production launch still needs real PostgreSQL multi-worker, restart, restore and
concurrency acceptance. Refer to
`ACCEPTANCE.md` for the full delivery checklist.
