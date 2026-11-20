# Phase 4: Production audit (1 to 2 September 2026)

## Goal

A second, production-focused audit across Amma Wallet and the LMS. It checked the new SSO and OAuth code and verified that the July fixes held.

## What it found and fixed

- A 30-item verification list was checked in full, and 32 new findings were logged.
- **High:** refresh tokens and password-reset tokens were stored in plain text. Both are now hashed with SHA-256.
- **SSO and OAuth:** scope checks on consent, an hourly expiry on the signing-key cache, a daily clean-up of the token registry, a separate ID-token lifetime, callback logging without query strings, and Turnstile that fails hard in production when its secret is missing.
- **Shared:** timing-safe comparison for API keys and webhook signatures. The OAuth signing key moved out of the compose file into a Docker secret.
- Single-process limits (the SSO replay list and tenant API-key rate limits) were documented as needing Redis before running more than one instance.

All high findings and the critical medium ones were fixed. The rest were resolved or documented by 2 Sep.

## Where the detail is

The findings tracker, to-do list and low-severity remediation plan (`production-audit/`) are in git history (see [README](README.md)).
