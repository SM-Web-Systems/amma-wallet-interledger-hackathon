# Test report

Fresh runs in the cloud container (Node 22.23.4, local PostgreSQL 16). Backend suites use
`NODE_ENV=test WALLET_TEST_DATABASE_URL=postgres://postgres:synthetic@127.0.0.1:5432/wallet_test`
with `--fileParallelism=false --maxWorkers=1` (as in CI).

| Commit | Suite | Result | Kind |
| --- | --- | --- | --- |
| main `02f56a3` | backend / web / build | 639/639, 44/44, OK | baseline |
| snapshot `836d5d6` | backend | 877/877 (111 files) | unit, WASM PG, fixtures |
| snapshot `836d5d6` | web / build | 73/73, OK | jsdom |
| snapshot `836d5d6` | backend tsc | 67 diagnostics (= baseline), none in payment files | static |
| integration `859fb6d` (snapshot + M8 `1b123d2`) | backend | **956/956** (117 files, incl. 41 real-PG email-claim tests) | unit + real PG |
| integration `859fb6d` | web / build | **104/104**, OK | jsdom |
| integration `859fb6d` | XRP real-PG acceptance (`npm run test:postgres`, dedicated DB) | **15/15** | real PG 16 |
| integration `859fb6d` | audit | critical: clean. High runtime: only the allowlisted `decode-uri-component` (already on main). | static |
| `5f22111` | drizzle push probe | Before the fix, `drizzle-kit push` with stdin not a TTY **dropped all 9 payment tables**. After it, all 10 raw-SQL tables survive. | **real PG 16** |
| `200cee9` | payments + db + routes subset | 72/72 (15 files) | unit, WASM PG |
| `5654111` | payment-ledger concurrency acceptance | 4/4: 20 concurrent reservations on a balance of 10 give exactly 10; one reference raced on 10 connections posts 1 row; 40 opposite-direction transfers, no deadlock; append-only and balanced | **real PG 16** |
| **`edd8ff5`** (#13 final head; backend and web identical to main `aa6d2d1`) | backend | **1000/1000** (121 files) | unit + real PG |
| `edd8ff5` | web / build | **174/174** (23 files), build OK | jsdom |
| `edd8ff5` | real-PG acceptance (`npm run test:postgres`, fresh `amma_xrpl_acceptance_c4`) | **19/19** (3 files: XRP financial, recovery, payment ledger) | real PG 16 |
| `edd8ff5` | backend tsc | 66 diagnostics, all pre-existing (server.ts, trustlines, auth, schema). None in payment or XRP modules. | static |
| `edd8ff5` | GitHub CI | 6/6 jobs green, including both production images | CI |

One container incident: local PostgreSQL stopped during a run (ECONNREFUSED in
`email-claims.pg.test.ts`). It was restarted and the file re-ran 41/41. This was an environment issue, not a code failure.

## Not run

- Rafiki two-peer stack: image blobs are blocked by network policy.
- Any real Stellar/XRPL Testnet funding or ILP transfer. Mixed-chain tests use fixture adapters labelled `simulated`.
- Partner APIs (VALR, FiveWest, TDME): no verified access.
