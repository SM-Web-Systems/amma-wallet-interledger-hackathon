# Phase 2: July security audit (25 to 29 July 2026)

## Goal

Audit the whole codebase (backend, web app, Docker and deployment) and fix everything exploitable, with tests, before more features went on top.

## How it ran

1. **Discovery, phases P0 to P4:** a module-by-module scan covering authentication, signing, transactions, data protection and infrastructure. It produced 319 findings.
2. **Remediation, phase 5 (5B to 5D):** every critical finding and every exploitable high finding.
3. **Phases 6A and 6B:** quick wins, hardening and a startup crash fix. 6B moved HD key derivation to the client.
4. **Backlog batches 1 to 4 (28 to 29 Jul):** validation, rate limits and concurrency fixes, each batch with its own spec, review checklist, deploy and post-deploy check.

Every fix was test-first, went through a code review gate and a secret scan, and was checked after each production deploy.

## Results

| Severity | Found | Resolved |
|---|---:|---:|
| Critical | 14 | 14 |
| High | 43 | 24 (the rest were stub modules and test coverage) |
| Medium | 94 | 30 |
| Low | 101 | 28 |
| Info | 67 | 67 (correct as built) |

- Tests went from none to 387 by the end of the audit.
- Examples of what was fixed: a login crash on unknown users, missing auth on the earn and other financial routes, a PIN bypass on transaction signing, a billing race (now `FOR UPDATE`), floating-point billing maths (now exact integers), plaintext TOTP secrets (now AES-256-GCM), hard-coded Docker secrets (now Docker secrets), a root Docker user, Turnstile failing open, no audit log on admin actions, and logout that didn't revoke tokens.
- Production was deployed several times with zero downtime. The final state was tagged `batch4-complete-2026-07-29`.
- 155 non-exploitable items were deferred as code-quality and feature work.

## What remains from it

[SECURITY_POSTURE.md](../../SECURITY_POSTURE.md) began as this audit's before-and-after report. It is kept and was updated in phase 7 for the managed custody model. The audit plans, findings tracker (`FINDINGS.md`), fix plans, merge plans and reports are in git history (see [README](README.md)).
