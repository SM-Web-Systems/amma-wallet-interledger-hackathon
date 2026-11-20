-- Run only through migrate-fee-sweeps-v1.ts, in one transaction.
-- Fee sweeps (owner decisions of 16 Nov 2026): the fee share of each credited deposit, and each month's wallet management
-- charge, are paid from the business wallet to that business's hardware fee address. The hardware wallet only ever receives.
-- One row per source (a deposit or a management charge), so each is paid at most once. Every hash ever built is kept.
CREATE TABLE IF NOT EXISTS fee_sweeps (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  network text NOT NULL CHECK (network IN ('testnet','public')),
  source_ref text NOT NULL CHECK (source_ref ~ '^(deposit|management):[0-9]{1,20}$'),
  amount_xlm numeric(18,7) NOT NULL CHECK (amount_xlm > 0),
  from_address text CHECK (from_address IS NULL OR from_address ~ '^G[A-Z2-7]{55}$'),
  to_address text CHECK (to_address IS NULL OR to_address ~ '^G[A-Z2-7]{55}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','submitting','submitted','confirmed','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  tx_hash text CHECK (tx_hash IS NULL OR tx_hash ~ '^[0-9a-f]{64}$'),
  tx_hashes text[] NOT NULL DEFAULT '{}',
  deadline bigint,
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT fee_sweeps_once UNIQUE (network, source_ref),
  CONSTRAINT fee_sweeps_confirmed CHECK (state <> 'confirmed' OR (tx_hash IS NOT NULL AND confirmed_at IS NOT NULL AND to_address IS NOT NULL)));
CREATE INDEX IF NOT EXISTS idx_fee_sweeps_open ON fee_sweeps (network, state) WHERE state IN ('pending','submitting','submitted');
