# Phase 1: Stellar MVP (February to June 2026)

## Goal

Ship a working Stellar wallet with a web app and an API, then grow it into a full-featured product for ammawallet.com.

## What shipped

- **First release (21 to 23 Feb):** the Stellar web wallet and backend, account sign-up and login, wallet sync between the server and every platform, SPA hosting.
- **Accounts:** password reset by email (Mar) and later by SMS, phone verification, email verification, TOTP, email codes and backup codes for 2FA, Cloudflare Turnstile on sign-up and login.
- **Wallets:** multiple Stellar wallets per account with BIP-39 recovery phrases, import by secret key or phrase, rename and delete. At this point users chose between self-custody and delegated signing protected by a PIN. That PIN model is retired in phase 7.
- **Tokens:** a curated token list, a token indexer fed by Horizon and StellarExpert, self-hosted icons, trustline management, price charts and orderbook depth, and a quality gate that hides junk tokens.
- **Trading and earning:** DEX swaps with path-finding, liquidity pool deposit and withdrawal, and an auto-liquifier that converts platform fees to XLM.
- **Fiat:** MoneyGram cash-in and cash-out through SEP-10 and SEP-24.
- **Other:** portfolio snapshots, address book, web push notifications, dark and light themes, 18 languages, NFT indexing, sync and mint endpoints.
- **Ecosystem:** the `@amma-wallet/stellar-wallets-kit-module` package, published to npm on 27 Jun so dApps can connect to Amma.

## Feature priorities at the end of the phase

The June MoSCoW list (removed in the cleanup) counted v1.0 with 20 must-have features done, v1.1 with 14 should-have features done, and v1.2 with 4 could-have features done. Planned for v2.0: an SEP-24 anchor platform, custom fiat corridors, multichain support, Soroban contracts and native mobile apps. Multichain and the mobile apps arrive in phases 5 to 7.

## Left for later

The code had no automated tests and had never had a security review. That is what phase 2 fixed.
