# Exchange integration roadmap

The checkout can eventually compare eligible routes from VALR, Luno, Binance,
Bitget, FiveWest and TDME. An exchange listing or indicative order book is not
proof that a complete, executable XRP-to-Stellar-USDC or ZARC corridor exists.
The current application has one configured partner gateway; it does not yet
integrate these four exchanges or aggregate multiple gateways.

## Priorities

1. Confirm VALR corporate account and subaccount permissions, XRP deposit and
   destination tags, live XRP/USDC and ZAR markets, and Stellar USDC network
   availability. VALR's docs contain a Stellar USDC example, but current
   supported networks must be checked on the authenticated account.
2. Check Luno business integration and automated South African crypto sends.
   Its documented send API notes a restriction for countries with Travel Rule
   requirements; South Africa is in scope. Confirm any business exception.
3. Evaluate Binance and Bitget using supported spot test environments and
   account-specific terms, networks, withdrawals and South African entity details.
4. Integrate TDME ZARC and FiveWest where Amma's actual agreements enable them.

## Engineering changes

- Replace the single gateway setting with a registry of independently configured
  provider adapters. The planner must request bounded executable routes from
  every eligible adapter, include all fees and latency, and identify the provider
  used for each approved leg. Do not treat order-book snapshots as guaranteed fills.
- Persist exchange deposit instructions, tags, network and issuer identity,
  provider credit, order IDs, partial fills, withdrawals and target-chain
  confirmation. Use each provider's documented idempotency semantics; investigate
  ambiguous outcomes without submitting a second order or withdrawal.
- After confirmed funding, requote and execute within the customer's approval.
  If partial fills or changed costs prevent exact delivery, preserve the actual
  assets held for recovery. Provider balances become eligible only after an
  authorized custody/account arrangement and reconciliation are established.
- Use distinct scoped credentials, network allowlists, provider-level pause
  controls and independent reconciliation. Assess actual deposit/withdrawal
  confirmations and the working-capital cost of prefunding each exchange.
- Test discovery and quotes read-only first; then run a complete isolated
  lifecycle including failure and restart cases for each provider and corridor.

## Sources reviewed 2026-10-31

- https://docs.valr.com/
- https://www.luno.com/en/developers/api
- https://guide.luno.com/hc/en-gb/articles/11035627274269-Frequently-asked-questions-about-the-Travel-Rule
- https://developers.binance.com/en/docs/introduction
- https://www.bitget.com/docs/classic/catalog?tab=broker
