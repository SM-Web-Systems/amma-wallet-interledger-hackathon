# Amma Wallet: one checkout across wallet balances

**For the Interledger hackathon judges.** This is our entry for the spaza shop payments challenge: a prototype on testnet, with a test asset only. This repository is a snapshot of our source code taken on 20 November 2026, published without git history. Internal plans, audit notes, runbooks and CI configuration are not included.

## What it is

A customer pays one invoice. Amma plans the funding across the customer's managed balance and Stellar assets, and the exact amount is delivered over Interledger with Open Payments and Rafiki. Native XRP funding is built but needs a partner gateway, which is off by default. A shop can also pay a supplier by entering the supplier's wallet address. The recipient amount is fixed, the customer side flexes to cover it, and unused funds are returned.

## Try it

- Live testnet web app: https://testnet.ammawallet.com. The payments screen is at `/payments`, from the menu item "Pay shop or supplier".
- Anyone can create a testnet account there (an email address plus a human check). New accounts hold no test ZARC (a new testnet Stellar wallet only receives test XLM from Friendbot), so don't expect to complete a payment without a ZARC top-up. The recorded presentation shows the full flow.

Everything runs on test networks with a test asset (ZARC, not a real currency). Nothing is enabled on mainnet and no real money is involved.

## Where to look in the code

| Path | What it is |
|---|---|
| `packages/backend/src/modules/payments/` | Interledger payments: funding planner, ledger, Rafiki and Open Payments adapters, webhooks, workers. |
| `packages/backend/src/routes/payments.ts` | Payments API routes. |
| `packages/web-app/src/pages/Payments.tsx`, `PaymentConsent.tsx` | The payments screen and the Open Payments consent page. |
| `docker/interledger/` | The two-peer Rafiki test stack (compose files and example config; no secrets). |
| `docs/interledger/` | Design, developer spec, API, diagrams, test report, acceptance and verification notes, and the hackathon submission notes. Start with [docs/interledger/README.md](docs/interledger/README.md). |

## What is real and what is not

- **Real test runs.** A first two-peer run on an isolated local stack took place on 3 November. On 9 and 10 November, two separate Rafiki v2.4.2-beta providers (each with its own auth server and database, both run by us on one server) paid each other over Interledger on the testnet server, using Open Payments SDK 7.4.0. Payments funded from the managed balance completed, and one funded from Stellar completed. A ledger check after every step found 0 mismatches. Those runs drove the payments API directly; the web payments screen is shown in the recording.
- **Built and tested with fixtures.** XRP-funded and mixed Stellar plus XRP funding: the planner, signing and ledger logic are unit-tested. The conversion step is simulated in fixture tests, because we have no verified partner sandbox. The deployed testnet has no conversion route, and the screen labels simulated quotes.
- **Failure handling, rehearsed on an isolated test stack.** Duplicate webhook, worker killed mid-payment, no liquidity, two workers, and pause. A lost webhook was rehearsed. A lost create-payment response, underpayment and partial delivery have not been run live (partial delivery and part-paid expiry have unit tests).
- **Not shown.** XRP-funded or mixed payments through a real conversion. Peering with an external Interledger node. Real money. Shop and supplier interviews.
- **Not claimed.** Zero fees, instant bank settlement, every asset available, production readiness or regulatory coverage.

## Research status

No shop or supplier interviews were done before this submission. The barriers named in the deck come from the organizers' brief, and the customer and supplier needs are hypotheses. The interview guide is in [docs/interledger/HACKATHON_SUBMISSION.md](docs/interledger/HACKATHON_SUBMISSION.md). Impact is expected, not measured.

## Dates

The Interledger payments layer was first committed on 3 November 2026, with a first two-peer run on an isolated local stack that day. Live two-peer runs on the testnet server were on 9 and 10 November. The payments screen sits behind the `VITE_PAYMENTS_ENABLED` build flag and is switched on in the testnet web build for the demo. The organizers' pages give different build periods (Schedule and Rules: 5 October to 5 November; About: September), so we state our dates and leave the call to them. Amma's web, phone and browser-extension wallets, the Stellar wallet and a native XRP testnet candidate existed before the Interledger layer.

## Acknowledgements

- Interledger Foundation: Interledger and Open Payments. Rafiki v2.4.2-beta, with its schemas vendored unmodified under their licence. Open Payments SDK 7.4.0.
- The Stellar network and SDKs. xrpl.js and the XRP Ledger testnet. PostgreSQL. Cloudflare and Let's Encrypt for the public Rafiki endpoints of the testnet deployment.
- AI assistance: much of the code, tests and documents were written and reviewed with Claude (Anthropic), under the team's direction and review.

---

## About Amma Wallet

Amma Wallet is a multichain wallet for Stellar, XRP Ledger and Ethereum. It runs on the web, on iOS and Android (Expo), and as a Chrome extension. One account login opens wallets that Amma holds for the user (managed custody), with self-custody kept as an option for users who choose it. The wallet also handles Interledger (Open Payments) payments, LMS reward claims, a partner SSO and OAuth provider, and an admin console for tenants and billing.

**Live:** [ammawallet.com](https://ammawallet.com) · **API docs:** [ammawallet.com/docs](https://ammawallet.com/docs)

### Repository layout

| Path | What it is |
|---|---|
| `packages/backend` | Fastify 5 API in TypeScript. PostgreSQL through Drizzle ORM. Stellar SDK, `xrpl`, `viem` and the Open Payments SDK. Custody, key escrow and recovery, payments ledger, SSO and OAuth, admin and billing, LMS activations, background jobs. |
| `packages/web-app` | React 19 single-page app (Vite 8, Tailwind 4, Zustand, i18next). Wallet pages for every chain, Interledger payments, admin console, OAuth consent and LMS claim pages. Installable as a PWA. |
| `packages/mobile` | Expo SDK 58 / React Native app for iOS and Android. |
| `packages/chrome-extension` | Chrome extension wallet (Vite, React). |
| `packages/evm-core` | Shared EVM engine: network registry, exact amounts, transfer construction, approval-bound signing and transaction tracking. |
| `packages/stellar-wallets-kit-module` | Amma module for Stellar Wallets Kit, published to npm so dApps can connect to Amma. |
| `docker/` | Production Docker env template, XRPL testnet override and the two-peer Rafiki (Interledger) test stack. |

### Custody model in one paragraph

Wallets are held by Amma by default and opened with the account login. Legacy PIN wallets are being retired and moved to managed custody; a user can't keep a PIN or switch to a self-held passphrase for those wallets. Mainnet custody, server signing and per-asset send caps are each behind their own switch and are off unless turned on. [SECURITY_POSTURE.md](SECURITY_POSTURE.md) has the full key model, controls and known gaps.

### Getting started

Prerequisites: Node.js 20+, npm 10+ and PostgreSQL 16+.

```bash
# API
cd packages/backend
npm install
cp .env.example .env   # then fill in the database URL and secrets
npm run dev

# Web app (in another terminal)
cd packages/web-app
npm install
npm run dev
```

Each package has its own `npm test` (Vitest). The backend also has `npm run test:integration`, which needs a disposable PostgreSQL database. Schema changes go through the reviewed, guarded migrations, never `drizzle-kit push` against a shared database.

### Documentation

| Where | What |
|---|---|
| [docs/phases/](docs/phases/README.md) | **Start here.** One short summary per development phase, from the February MVP to today. |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design and diagrams. |
| [docs/API.md](docs/API.md) | REST API reference (Swagger UI is served at `/docs`). |
| [SECURITY_POSTURE.md](SECURITY_POSTURE.md) | Key custody model, controls in force and known gaps. |
| [docs/interledger/](docs/interledger/README.md) | Open Payments design, API, diagrams, partner gateway and hackathon submission. |
| [docs/xrpl/](docs/xrpl/README.md) | XRPL integration contract and OpenAPI file. |
| [docs/evm/DESIGN.md](docs/evm/DESIGN.md) | Ethereum engine design. |

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 SM Web Systems.
