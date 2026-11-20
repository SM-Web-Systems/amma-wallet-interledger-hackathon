# Phase 7: Managed custody and the wallet assessment (13 November 2026 to now)

## Goal

Look at the whole product with fresh eyes, fix what a real user would hit, and move to a custody model that ordinary users can live with.

## Fresh-eyes assessment (from 13 Nov)

docs/assessment/2026-11/ holds the assessment: ground rules, a unit-test baseline (1,852 passing on 13 Nov), user journeys for every chain and client, UX and competitor reviews, a gap analysis, data and privacy reviews, diagrams, specs and a design system. Its first fix queue (G-01 to G-45) covered items such as a new idempotency key per payment, a hashed static 2FA code, balance errors that no longer look like zero, Send errors next to the field, an accessibility scan, and longer test time limits on slow CI hosts.

## Custody by default

- **13 Nov decision:** Amma holds wallets by default (managed custody), and self-custody is the exception. The recovery phrase is escrowed on the server. Recovery without the passphrase needs the account password, an email code and a waiting period. One phrase derives Stellar, XRP and Ethereum accounts, with test vectors.
- **Mainnet switches, each off by default:** `MAINNET_CUSTODY`, server signing and an allow-list of users. XRP custody on mainnet has its own switch (`XRPL_MAINNET_CUSTODY`), and device wallets can be moved into Amma custody (testnet first).
- **Caps (16 Nov):** per-asset limits on mainnet sends from Amma-held Stellar wallets (runbook). There is also a platform fee on every Stellar send.
- **19 Nov rule, not negotiable:** users can't keep a PIN and can't switch to a self-held passphrase either. Legacy PIN wallets move to managed custody, opened by the account login. The extension and server retired PIN wallets on 20 Nov (#290, #293).
- [SECURITY_POSTURE.md](../../SECURITY_POSTURE.md) describes the current key model and its known gaps (no KMS or HSM yet, and phrase read-back needs only the password).

## WA queue (from 16 Nov)

docs/assessment/TODO.md is the live queue. Each row has a spec and plan in docs/superpowers/. Done so far includes a single Stellar envelope per review, idempotent custody sends, schema safety, mainnet caps, the LMS claim page, password-reset recovery (including by SMS), network-true labels, OAuth code binding and activation states in the UI. Still open: sign-up landing on the Amma wallets (WA-06, merged on testnet, mainnet deploy pending), SSO assertion audience (WA-05), no funding at sign-up (WA-07), Interledger retry caps and limits (WA-11), and smaller items.

## Other work in this phase

- Ethereum server data through Alchemy (balances, history, send preview with `eth_simulateV1`, incoming alerts), all behind flags (runbook).
- Task-gated wallet activation for LMS tenants (behind `TASK_ACTIVATION`).
- Turnstile on admin sign-in (runbook), and a warning for address-poisoning payments in History.
- Idle and hidden-tab lock for device wallets, and English-only first download with other languages loaded on demand.

## Infrastructure changes

- **19 Nov:** the AWS account was closed, which took the self-hosted runners and the host described in docs/DEPLOYMENT.md offline. That guide is out of date until a replacement host is documented.
- **CI:** CircleCI briefly took over main CI (19 Nov) and is now paused. The GitHub workflows run on Blacksmith runners (#316), with the npm audit gate restored (#318).
- **20 Nov:** the old plans, prompts and reports were removed from the tree and replaced by these phase summaries. A clean public copy for the Interledger judges is built from this cleaned `main`.
