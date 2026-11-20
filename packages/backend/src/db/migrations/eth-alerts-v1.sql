-- Run only through migrate-eth-alerts.ts, in one transaction.
-- Incoming Ethereum payment alerts (ETH_ALERTS=on): one row per (network, transfer event, wallet); doubles as the user's unread inbox.
CREATE TABLE IF NOT EXISTS eth_incoming_alerts (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  network text NOT NULL CHECK (network IN ('sepolia','ethereum')),
  to_address text NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  from_address text CHECK (from_address IS NULL OR from_address ~ '^0x[0-9a-f]{40}$'),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  asset text NOT NULL CHECK (length(asset) BETWEEN 1 AND 40),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  seen_at timestamptz,
  CONSTRAINT eth_incoming_alerts_event_key UNIQUE (network, tx_hash, event_key, to_address));
CREATE INDEX IF NOT EXISTS idx_eth_incoming_alerts_unseen ON eth_incoming_alerts (user_id, created_at) WHERE seen_at IS NULL;
