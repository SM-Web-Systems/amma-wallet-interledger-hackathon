-- Run only through migrate-activation-v1.ts, in one transaction.
-- Task-gated wallet activation (Stellar first). Rows are financial evidence: ON DELETE RESTRICT everywhere.
CREATE TABLE IF NOT EXISTS partner_signing_keys (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{4,64}$'),
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (tenant_id, key_id));

CREATE TABLE IF NOT EXISTS partner_activation_settings (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  daily_cap integer NOT NULL DEFAULT 50 CHECK (daily_cap >= 0),
  allow_debt boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL);

CREATE TABLE IF NOT EXISTS partner_tasks (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  task_key text NOT NULL CHECK (task_key ~ '^[a-z0-9:_-]{1,80}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  chains text[] NOT NULL CHECK (cardinality(chains) BETWEEN 1 AND 3 AND chains <@ ARRAY['stellar','xrpl','evm']),
  payer text NOT NULL DEFAULT 'tenant' CHECK (payer IN ('tenant','amma')),
  evm_gas_grant_wei numeric(40,0) NOT NULL DEFAULT 0 CHECK (evm_gas_grant_wei BETWEEN 0 AND 300000000000000),
  daily_cap integer CHECK (daily_cap >= 0),
  total_cap integer CHECK (total_cap >= 0),
  CONSTRAINT partner_tasks_amma_needs_caps CHECK (payer <> 'amma' OR (daily_cap IS NOT NULL AND total_cap IS NOT NULL)),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  UNIQUE (tenant_id, task_key));

CREATE TABLE IF NOT EXISTS partner_task_completions (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  task_id bigint NOT NULL REFERENCES partner_tasks(id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  api_key_id bigint NOT NULL REFERENCES tenant_api_keys(id) ON DELETE RESTRICT,
  signing_key_id bigint NOT NULL REFERENCES partner_signing_keys(id) ON DELETE RESTRICT,
  partner_completion_id text NOT NULL CHECK (length(partner_completion_id) BETWEEN 8 AND 100),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, partner_completion_id),
  UNIQUE (tenant_id, task_id, user_id));

CREATE TABLE IF NOT EXISTS wallet_activations (
  id bigserial PRIMARY KEY,
  completion_id bigint NOT NULL REFERENCES partner_task_completions(id) ON DELETE RESTRICT,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  wallet_id bigint NOT NULL REFERENCES user_wallets(id) ON DELETE RESTRICT,
  chain text NOT NULL CHECK (chain IN ('stellar','xrpl','evm')),
  network text NOT NULL CHECK (network IN ('testnet','public','mainnet','sepolia','ethereum')),
  address text NOT NULL,
  payer text NOT NULL CHECK (payer IN ('tenant','amma')),
  grant_base_units numeric(40,0) NOT NULL CHECK (grant_base_units >= 0),
  state text NOT NULL CHECK (state IN ('awaiting_budget','reserved','submitting','submitted','confirmed',
    'failed','failed_final','skipped_already_active','skipped_chain_unavailable','refunded','expired')),
  tx_hash text,
  -- Every transaction ever built for this activation, oldest first. Never cleared: a late-landing earlier attempt must stay findable.
  tx_hashes text[] NOT NULL DEFAULT '{}',
  deadline text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_-]{1,40}$'),
  billing_event_id bigint REFERENCES billing_events(id) ON DELETE RESTRICT,
  refund_billing_event_id bigint REFERENCES billing_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT wallet_activations_once_per_completion UNIQUE (completion_id, chain));
-- One live activation per address. Skipped, refunded and expired rows are records only and never block a later one.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_activations_once_per_address ON wallet_activations (chain, network, address)
  WHERE state IN ('awaiting_budget','reserved','submitting','submitted','confirmed','failed');
CREATE INDEX IF NOT EXISTS idx_wallet_activations_work ON wallet_activations (state, updated_at)
  WHERE state IN ('reserved','submitting','submitted','failed','awaiting_budget');
CREATE INDEX IF NOT EXISTS idx_wallet_activations_user ON wallet_activations (user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_activations_tenant_day ON wallet_activations (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS activation_reconciliations (
  id bigserial PRIMARY KEY,
  chain text NOT NULL,
  network text NOT NULL,
  day date NOT NULL,
  db_total numeric(40,0) NOT NULL,
  chain_total numeric(40,0) NOT NULL,
  mismatches jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, network, day));
