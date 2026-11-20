# Phase 6: Interledger, Ethereum and the first autonomous release (3 to 12 November 2026)

## Goal

Go multichain on every platform: XRP first, then Ethereum, then other EVM networks, across web, mobile and the extension. Add Interledger payments. Release the outstanding work in one controlled run.

## Autonomous release run (3 to 4 Nov)

Claude ran as release lead for 24 hours on a fixed budget. It merged the XRP M2 to M8 and Interledger integration, mobile and extension security patches with a working mobile bundle, the shared EVM engine and the Ethereum Sepolia web wallet.

The key safety fix from this run: `drizzle-kit push` could drop the payment ledger. Deploys therefore never change the schema now. The payment schema runs as a guarded, checksum-marked migration, and a read-only schema gate refuses to start the API when migrations are missing. `deploy.sh` came from this work. Testnet deploys needed the owner's own device, because the cloud session could not reach the host.

## Interledger (Open Payments)

- A customer ledger separate from tenant billing, with balanced postings, no negative balances and a reconciliation command.
- Funding plans across managed accounts, Stellar assets and testnet XRP, with fees, reserves and quote expiry.
- Invoices, quotes, approvals, funding legs, receipts, claims and idempotency records, all persisted. Payment is one per invoice, with per-asset limits.
- Open Payments SDK 7.4.0, Rafiki Admin for outgoing payments, GNAP consent, and signed Rafiki webhooks with deduplication.
- A two-peer Rafiki test stack in [docker/interledger/](../../docker/interledger/) and end-to-end runs on 3, 9 and 10 Nov.
- The hackathon submission and partner gateway notes are kept in [docs/interledger/](../interledger/README.md).

## Ethereum

- `packages/evm-core`: network registry, exact amounts, transfers, approval-bound signing and tracking ([design](../evm/DESIGN.md)). Sepolia only, with mainnet refused by name.
- Web wallet, off by default: signed transfers persist across reloads, a stuck transfer can be cancelled with the user's approval, and every error has a plain message.

## Clients, security and CI (5 to 12 Nov)

- New Stellar wallets need a passphrase of 12 or more characters, and old PINs were upgraded (web and extension). Mobile generates and checks Stellar keys on the device.
- Phone tab bar and shared UI for the XRP and Ethereum pages. A Playwright visual smoke test runs on a production build in CI.
- Mobile on Expo SDK 58, an offline fallback so the web app installs as a PWA, and tabs that refresh one at a time so they don't sign each other out.
- CI used self-hosted ARM64 runners on AWS, limited to trusted authors. The backend is precompiled at image build.
- A design, recovery-phrase and audit pack (10 Nov) set up the assessment loop that phase 7 runs.

## Where the detail is

The rollout plan, release reports, Claude prompts and handoffs, E2E run logs and design pack are in git history (see [README](README.md)).
