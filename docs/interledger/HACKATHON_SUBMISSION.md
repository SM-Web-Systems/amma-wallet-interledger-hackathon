# Amma: one checkout across wallet balances

## Research guide

Interview 3–5 shop owners and one supplier. Ask about the last actual sale or
restocking payment, rather than asking whether they like the proposed app.

1. How did the customer/supplier pay, and which systems were involved?
2. What amount was charged, what fee was paid, and when were funds usable?
3. What happens when the preferred wallet or balance cannot cover the payment?
4. What proof of payment does each party trust? How do failed payments get resolved?
5. Which phone, connectivity and language constraints affect the transaction?
6. Walk through the prototype. Where do they hesitate or need help?

Record anonymized observations, participant permission and resulting design changes.
Do not invent interview findings. Financial inclusion and adoption claims require
evidence beyond a successful technical demonstration.

## Presentation / 12-minute recording script

| Segment | Time | Demonstration and evidence |
| --- | --- | --- |
| Problem | 0:00–1:30 | Shop/supplier workflow and actual research findings. |
| Proposed journey | 1:30–2:30 | One invoice, automatic source selection and clear recipient amount. |
| Customer checkout | 2:30–5:00 | Scan QR, review combined Stellar/XRP funding and fees, sign locally. |
| Interoperability | 5:00–6:30 | Show distinct provider addresses, quote, outgoing and incoming resources. |
| Supplier payment | 6:30–8:00 | Shop enters supplier wallet address and pays without a swap screen. |
| Failure handling | 8:00–9:30 | Pending funding, duplicate event, pause and recovery with ledger evidence. |
| Architecture | 9:30–10:30 | Customer ledger, adapters, SDK, Rafiki, liquidity and settlement boundary. |
| Impact and limitations | 10:30–12:00 | Measured costs/timing; tested versus simulated behavior; next pilot gates. |

Use the sequence diagram in README. Clearly identify which Amma/XRP components
predate this hackathon and which changes belong to this entry. Credit Interledger,
Rafiki, Stellar, xrpl.js, other libraries and AI assistance.

Presenting the prototype does not establish zero fees, instant bank settlement,
availability of every asset, production readiness or regulatory coverage. Label
fixture FX and any simulated settlement on the screen and in the recording.

## Submission folder

- Presentation PDF or PowerPoint exported after real demo/research evidence is added.
- 10–15 minute recording.
- Reviewed demo or source link with setup and known limitations.
- Architecture, test evidence, research notes and component acknowledgements.

The published build period ends 5 November 2026 and the finale is 21 November.
Confirm the exact cutoff with organizers; the site contains inconsistent date text.
No outreach, publication, recording or Slack submission has been performed by the
implementation session.
