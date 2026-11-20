# Phase 5: RBAC, billing and XRPL (October 2026)

## Goal

Make tenant billing provably correct, tighten the LMS hand-off, and add the second chain: XRP Ledger on testnet.

## RBAC and billing audit (20 Oct)

- The RBAC and billing backend and UI were audited and specced, with an architecture write-up, a test strategy and a decision log.
- **Credit posting idempotency:** a repeated credit request can no longer post twice. It uses an idempotency key, a partial unique index, a fingerprint that covers bundle fields, and safe handling when two requests race.
- A real runtime error in the auto-suspension job, which had been hidden by a catch-all, was found and fixed.
- Playwright end-to-end tests were added (38 cases), and the integration test harness now refuses to run against a database it doesn't recognise.
- **Verdict:** conditionally ready. The blocking condition was applying the idempotency index to production.
- Phase 5 and 5.1 independent code reviews followed, with fixes for strict constraint ids, fail-closed fingerprinting and a durable credit operation id.

## LMS and dependencies (23 to 25 Oct)

- Verified email onboarding before LMS access, with browser probes of the email flow.
- Synthetic auth and full web regression tests run on every pull request.
- The first dependency-security triage (the later Dependabot triage lives outside this repo).

## XRPL testnet (28 Oct onward)

A milestone plan, M1 to M8, built from a recorded baseline:

1. M1: the integration contract ([docs/xrpl/CONTRACT.md](../xrpl/CONTRACT.md)).
2. M2: wallet storage split by chain and network, behind a migration gate.
3. M3: a read adapter for XRPL.
4. M4: XRP wallet creation and import with encrypted local recovery.
5. M5: explicitly approved testnet payments with receipts.
6. M6: a recovery worker and proven expiry from ledger history.
7. M7: application API, approval links and claims ([openapi.v1.json](../xrpl/openapi.v1.json)).
8. M8: staging safeguards and isolated release acceptance.

Mainnet XRP stayed off. It is switched on per user in phase 7.

## Where the detail is

The audit folders under `docs/audits/` and the XRPL milestone notes, baseline, server reviews and evidence are in git history (see [README](README.md)).
