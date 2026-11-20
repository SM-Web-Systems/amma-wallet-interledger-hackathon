# Diagrams

## Current architecture (implemented, production per docs/DEPLOYMENT.md)

```mermaid
flowchart LR
  B[Browser SPA] -->|HTTPS| N[Nginx 443]
  N -->|/api /health| A[Fastify API :3001 PM2]
  N -->|static| D[web-app/dist]
  A --> P[(PostgreSQL 16)]
  A --> H[Stellar Horizon]
```

## Target with XRP Testnet (implemented on PR stack, not deployed)

```mermaid
flowchart LR
  B[Browser + local XRP vault] -->|signed blob only| A[API]
  A --> P[(PostgreSQL: xrpl_payments, events, claims)]
  A -->|allowlisted wss| X[XRPL Testnet x2]
  O[Operator control file RO] -.pause.-> A
  T[Tenant app API key] -->|claim receipt| A
```

## Trust boundaries

```mermaid
flowchart TB
  subgraph Client[User device - holds seed]
    V[Vault]
  end
  subgraph Server[Amma server - never holds XRP seed]
    API --> DB[(DB)]
  end
  subgraph Ledger[XRPL Testnet - source of truth for settlement]
    L[Validated ledger]
  end
  V -->|signed tx| API
  API -->|submit/observe| L
```

## XRP payment sequence

```mermaid
sequenceDiagram
  participant U as User browser
  participant A as API
  participant D as DB
  participant L as XRPL Testnet
  U->>A: POST intent (idempotency key)
  A->>D: insert awaiting_approval
  U->>A: prepare
  A->>L: account, fee, destination
  A->>D: prepared (seq, LLS)
  U->>U: sign locally
  U->>A: submit signed blob
  A->>D: persist signed (commit before broadcast)
  A->>L: submit
  A->>L: reconcile until validated or past LLS
  A->>D: validated_success + receipt
```

## Payment state and recovery

```mermaid
stateDiagram-v2
  [*] --> awaiting_approval
  awaiting_approval --> cancelled
  awaiting_approval --> prepared
  prepared --> signed
  signed --> submitted
  submitted --> validated_success
  submitted --> validated_failure
  prepared --> expired: history proves non-inclusion past LastLedgerSequence
  signed --> expired
  submitted --> expired
```

Review holds are not states. `lastObservation` values `INTEGRITY_MISMATCH`, `LEDGER_RESET`,
`SEQUENCE_CONSUMED` and `TRANSACTION_ALREADY_BOUND` freeze submission and rebroadcast on the
current state until a human reviews them. A timeout never creates a replacement transaction.

## PR dependency order

```mermaid
flowchart LR
  main --> 5[#5 M1 docs] --> 6[#6 M2 storage] --> 7[#7 M3 read] --> 8[#8 M4 vault] --> 9[#9 M5 payments] --> 10[#10 M6 reconcile] --> 11[#11 M7 API] --> 12[#12 M8 staging]
  W[worktree-rbac-billing-audit] --> 1[#1 Phase 5.1]
  IL[Interledger laptop work - not pushed]:::missing
  classDef missing stroke-dasharray: 5 5
```

## Deployment (gated)

```mermaid
flowchart LR
  R[Reviewed main SHA] --> BK[Backup + restore check]
  BK --> M[Guarded migrations, no db:push]
  M --> TN[Isolated Testnet API, paused]
  TN --> PF[staging-preflight]
  PF --> C[Canary unpause, dedicated wallet]
  C -->|unexpected| RP[Re-pause + rollback]
  C -->|ok| MN[Mainnet: separate user decision]
```
