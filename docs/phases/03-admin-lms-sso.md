# Phase 3: Admin console, LMS and SSO (late July to early September 2026)

## Goal

Make Amma usable by partner organisations: an admin console for tenants and billing, verifiable NFT credentials for the LMS, and a standards-based sign-in that other apps can rely on.

## What shipped

- **Admin console (AW-ADMIN-001 to 007):** billing staff can post credits, suspend and unsuspend tenants, page through billing events and manage admins without using curl. Role rules hold on the server: a platform admin can post credits but cannot suspend a super-admin tenant. Every write asks for confirmation first. The flow diagrams for this work are in [docs/diagrams/](../diagrams/).
- **NFT credentials:** credentials are matched by their Soroban token id instead of by position, and the credential flow is shown to the user.
- **LMS:** dashboard and mint confirmation flows for LMS rewards.
- **SSO multi-RP (26 Aug to 1 Sep):** Amma became an OAuth 2.1 identity provider for several relying parties. It has a client registry, ES256 signing with a JWKS endpoint, authorization code with PKCE, refresh-token rotation with family revocation, and consent records with an audit trail. The legacy `/api/v1/sso/*` flow was left byte-for-byte unchanged. An internal security review raised SR-001 to SR-011, and all were fixed before merge.

## Left for later

Frontend integration of the OAuth flow was still in progress when the phase 4 audit began. Binding OAuth codes and SSO assertions to one client is finished in phase 7 (WA-10 is done; WA-05 is still open).
