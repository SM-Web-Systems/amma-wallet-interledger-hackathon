-- Run only through migrate-oidc-nonce.ts, in one transaction.
-- OIDC nonce (audit 2026-11-18): the value a relying party sent to /oauth/authorize, bound to the
-- authorization code and echoed in the ID token. Nullable and additive: existing rows and clients are unaffected.
ALTER TABLE token_registry ADD COLUMN IF NOT EXISTS nonce text;
ALTER TABLE token_registry DROP CONSTRAINT IF EXISTS token_registry_nonce_shape;
ALTER TABLE token_registry ADD CONSTRAINT token_registry_nonce_shape CHECK (nonce IS NULL OR (token_type = 'auth_code' AND length(nonce) BETWEEN 1 AND 512));
