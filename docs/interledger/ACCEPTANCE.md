# Payment acceptance checklist

## Automated and local

- [x] Exact integer money, large values, rounding, invalid notation and precision.
- [x] Combined funding, fixed fees, same-source deduplication, expiry and exclusions.
- [x] Immutable balanced ledger pairs, insufficient funds and asset mismatch rollback.
- [x] Persisted reservations, process-object restart and exactly-once final posting.
- [x] Owner isolation, changed approval, conflicting idempotency and duplicate approval.
- [x] Definitive failure recovery and retention of uncertain payment outcomes.
- [x] Webhook canonicalization, tampering, expiry and signature version rejection.
- [x] GraphQL operations validated against the actual pinned Rafiki schemas.
- [x] Frontend production build.

Record final command results and browser artifacts in `VERIFICATION.md`; do not
mark the following boxes from a mocked test or a successful build.

## Isolated live acceptance

- [ ] Apply migration twice to representative PostgreSQL 16 data; backup and restore.
- [x] Start both pinned Rafiki instances; check auth/resource/private Admin endpoints. (E2E-RUN-2026-11-09)
- [x] Verify client key discovery, signed SDK requests and trusted TLS. (E2E-RUN-2026-11-09, test CA)
- [ ] Merchant provisions an asset-specific address and produces an incoming request.
- [ ] Browser consent permits only the owning account; deny and revoke work. (Approve and revoke done live 2026-11-09 through the consent API; deny and non-owner not exercised.)
- [ ] Fund a payment with Stellar only, XRP only, and a mix from both test networks. (Stellar only: done 2026-11-09. XRP and mixed: blocked, the XRP adapter needs a partner gateway.)
- [x] Prove no external funding is counted before authoritative confirmation. (E2E-RUN-2026-11-09 #11-12)
- [ ] Demonstrate automatic conversion through the verified partner sandbox.
- [x] Show actual ILP packets/payment resources across the two separate providers. (E2E-RUN-2026-11-09: payment resources and peer liquidity; packets not captured)
- [x] Verify recipient amount, payer charge, fees, liquidity changes and receipt. (E2E-RUN-2026-11-09 #1)
- [ ] Duplicate webhook, concurrent worker, worker restart and lost response rehearsals. (First three done 2026-11-09; lost create response not yet.)
- [ ] Simulate underpayment, partial delivery, stale quote and unavailable liquidity. (Stale quote and unavailable liquidity done live 2026-11-09; underpayment and partial delivery not live.)
- [x] Pause submissions while keeping observation/recovery working. (E2E-RUN-2026-11-09 #7)
- [ ] Existing Stellar and XRP acceptance checks continue to pass.

## Production and hackathon

- [ ] Reconcile with the server's accepted XRP candidate and existing local changes.
- [ ] Independent financial/security review and real database concurrency acceptance.
- [ ] Confirm actual provider permissions, limits, fees and settlement agreements.
- [ ] Verify production monitoring, secrets, backup restore and rollback procedure.
- [ ] Enable a limited merchant pilot under reviewed limits.
- [ ] Complete shop/supplier interviews and replace assumptions with findings.
- [ ] Record 10–15 minute walkthrough with real/simulated boundaries labelled.
- [ ] Export presentation, publish reviewed demo access, test shared-folder permissions.
- [ ] Confirm organizer cutoff; submit through the team's authorized process.
