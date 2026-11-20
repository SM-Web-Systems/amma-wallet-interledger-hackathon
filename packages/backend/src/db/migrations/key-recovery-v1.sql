-- Run only through migrate-key-recovery.ts, in one transaction.
-- A user who forgot their wallet passphrase asks for recovery; the request waits (48 hours on mainnet)
-- so the real owner can see the alerts and cancel. At most one open request per user.
CREATE TABLE IF NOT EXISTS wallet_key_recovery (
 id bigserial PRIMARY KEY,
 user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state text NOT NULL CHECK (state IN ('pending','cancelled','completed')),
 ready_at timestamptz NOT NULL,
 cancel_token_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_key_recovery_one_open ON wallet_key_recovery (user_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_wallet_key_recovery_token ON wallet_key_recovery (cancel_token_hash);
