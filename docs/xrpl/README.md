# XRP/XRPL implementation

The XRP Ledger integration was built in eight milestones from 28 October 2026. [docs/phases/05-rbac-billing-xrpl.md](../phases/05-rbac-billing-xrpl.md) summarises them.

Kept here:

- [Release A integration contract](CONTRACT.md)
- [OpenAPI v1 contract](openapi.v1.json) (a backend test compares the live API against this file)

The build plan, baseline, milestone 2 to 8 notes and runbooks, server reviews, reviewer handoff and evidence were removed from the tree on 20 Nov 2026. They are in git history at commit `d5ce510` (for example `git show d5ce510:docs/xrpl/MILESTONE_8.md`).

Mainnet XRP custody is behind `XRPL_MAINNET_CUSTODY` and is off by default.
