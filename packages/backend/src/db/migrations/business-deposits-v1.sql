-- Run only through migrate-business-deposits-v1.ts, in one transaction.
-- Deposits into each business wallet (owner decisions of 16 Nov 2026): a payment that equals exactly one bundle price
-- (with the first-deposit extras on the first) is credited automatically; anything else is held and escalated by email.
-- One row per Horizon payment operation, so a payment is never counted twice.
CREATE TABLE IF NOT EXISTS business_deposits (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  network text NOT NULL CHECK (network IN ('testnet','public')),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^G[A-Z2-7]{55}$'),
  operation_id text NOT NULL CHECK (operation_id ~ '^[0-9]{1,30}$'),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^[0-9a-f]{64}$'),
  from_address text NOT NULL CHECK (from_address ~ '^[GM][A-Z2-7]{55,}$'),
  amount_xlm numeric(18,7) NOT NULL CHECK (amount_xlm > 0),
  received_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('credited','held','resolved')),
  held_reason text CHECK (held_reason IS NULL OR held_reason IN ('no_bundle_matches_amount','amount_matches_more_than_one_bundle','no_catalog')),
  bundle_slug text,
  plan text CHECK (plan IS NULL OR plan IN ('monthly','annual')),
  users integer CHECK (users IS NULL OR users BETWEEN 1 AND 1000000),
  -- What the deposit pays for, from depositQuote. fee_due_xlm is what is owed to the business's hardware fee address.
  funding_xlm numeric(18,7) NOT NULL DEFAULT 0 CHECK (funding_xlm >= 0),
  management_xlm numeric(18,7) NOT NULL DEFAULT 0 CHECK (management_xlm >= 0),
  registration_xlm numeric(18,7) NOT NULL DEFAULT 0 CHECK (registration_xlm >= 0),
  reserve_xlm numeric(18,7) NOT NULL DEFAULT 0 CHECK (reserve_xlm >= 0),
  fee_due_xlm numeric(18,7) NOT NULL DEFAULT 0 CHECK (fee_due_xlm >= 0),
  credit_ledger_id bigint REFERENCES credit_ledger(id) ON DELETE RESTRICT,
  bundle_purchase_id bigint REFERENCES tenant_bundle_purchases(id) ON DELETE RESTRICT,
  escalated_at timestamptz,
  escalation_tried_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_deposits_once UNIQUE (network, operation_id),
  CONSTRAINT business_deposits_shape CHECK (
    (state = 'credited' AND held_reason IS NULL AND bundle_slug IS NOT NULL AND plan IS NOT NULL AND users IS NOT NULL AND credit_ledger_id IS NOT NULL)
    OR (state IN ('held','resolved') AND held_reason IS NOT NULL AND credit_ledger_id IS NULL)));
CREATE INDEX IF NOT EXISTS idx_business_deposits_tenant ON business_deposits (tenant_id, network, received_at);
CREATE INDEX IF NOT EXISTS idx_business_deposits_held ON business_deposits (state) WHERE state = 'held';

-- Where the watcher has read up to on each business wallet (a Horizon paging token).
ALTER TABLE business_wallets ADD COLUMN IF NOT EXISTS deposit_cursor text CHECK (deposit_cursor IS NULL OR deposit_cursor ~ '^[0-9]{1,30}$');
