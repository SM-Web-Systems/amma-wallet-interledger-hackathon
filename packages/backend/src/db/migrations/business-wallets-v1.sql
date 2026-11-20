-- Run only through migrate-business-wallets-v1.ts, in one transaction.
-- One Amma-held Stellar wallet per business and network (owner decision of 16 Nov 2026): deposits land there and
-- activations are paid from it. The secret is sealed with the master key provider (AES-256-GCM, bound to the business,
-- network and address) and is never stored or logged in plain text.
CREATE TABLE IF NOT EXISTS business_wallets (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  network text NOT NULL CHECK (network IN ('testnet','public')),
  address text NOT NULL CHECK (address ~ '^G[A-Z2-7]{55}$'),
  sealed_secret text NOT NULL CHECK (length(sealed_secret) BETWEEN 40 AND 4000),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9-]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 80),
  retired_at timestamptz,
  CONSTRAINT business_wallets_address_unique UNIQUE (address));
CREATE UNIQUE INDEX IF NOT EXISTS business_wallets_one_live ON business_wallets (tenant_id, network) WHERE retired_at IS NULL;

-- Public addresses on the owner's hardware wallet. Each business is given its own the first time it funds its account;
-- its fees go there from then on. Only public addresses are ever stored here.
CREATE TABLE IF NOT EXISTS fee_address_pool (
  id bigserial PRIMARY KEY,
  network text NOT NULL CHECK (network IN ('testnet','public')),
  address text NOT NULL CHECK (address ~ '^G[A-Z2-7]{55}$'),
  tenant_id bigint REFERENCES tenants(id) ON DELETE RESTRICT,
  assigned_at timestamptz,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by text NOT NULL CHECK (length(added_by) BETWEEN 1 AND 80),
  CONSTRAINT fee_address_pool_address_unique UNIQUE (address),
  CONSTRAINT fee_address_pool_assigned CHECK ((tenant_id IS NULL) = (assigned_at IS NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS fee_address_pool_one_per_tenant ON fee_address_pool (tenant_id, network) WHERE tenant_id IS NOT NULL;

-- Which wallet paid each grant (the shared treasury or a business wallet), for reconciliation.
ALTER TABLE wallet_activations ADD COLUMN IF NOT EXISTS source_address text;
