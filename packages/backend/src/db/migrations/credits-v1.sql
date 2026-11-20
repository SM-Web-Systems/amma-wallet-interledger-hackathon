-- Run only through migrate-credits-v1.ts, in one transaction.
-- Business credit plans (owner decisions of 16 Nov 2026): monthly bundles at 3.4 XLM per user, annual at 4.1,
-- credits and pots per business, an append-only credit ledger, and per-wallet plan tracking for the monthly fee.
-- Additive only: nothing here changes how today's activation or billing code behaves.

ALTER TABLE bundle_catalog
  ADD COLUMN IF NOT EXISTS plan text,
  ADD COLUMN IF NOT EXISTS users integer;
ALTER TABLE bundle_catalog DROP CONSTRAINT IF EXISTS bundle_catalog_plan_users;
ALTER TABLE bundle_catalog ADD CONSTRAINT bundle_catalog_plan_users
  CHECK ((plan IS NULL AND users IS NULL) OR (plan IN ('monthly','annual') AND users BETWEEN 1 AND 1000000));

-- The old fixed tiers (3 XLM per user) are retired, not deleted: past purchases still point at them.
UPDATE bundle_catalog SET is_active = false WHERE slug IN ('starter-100','starter-200','growth-500','scale-1000');
INSERT INTO bundle_catalog (slug, name, approx_users, users, plan, price_xlm, is_active, sort_order) VALUES
  ('monthly-100',  'Monthly 100',   100,  100, 'monthly',  340.0, true, 10),
  ('monthly-200',  'Monthly 200',   200,  200, 'monthly',  680.0, true, 11),
  ('monthly-500',  'Monthly 500',   500,  500, 'monthly', 1700.0, true, 12),
  ('monthly-1000', 'Monthly 1000', 1000, 1000, 'monthly', 3400.0, true, 13),
  ('annual-100',   'Annual 100',    100,  100, 'annual',   410.0, true, 20),
  ('annual-200',   'Annual 200',    200,  200, 'annual',   820.0, true, 21),
  ('annual-500',   'Annual 500',    500,  500, 'annual',  2050.0, true, 22),
  ('annual-1000',  'Annual 1000',  1000, 1000, 'annual',  4100.0, true, 23)
ON CONFLICT (slug) DO NOTHING;

-- One row per business: what it has left to spend. Changed only together with a credit_ledger row.
CREATE TABLE IF NOT EXISTS tenant_credit_balances (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  annual_credits integer NOT NULL DEFAULT 0 CHECK (annual_credits >= 0),
  monthly_credits integer NOT NULL DEFAULT 0 CHECK (monthly_credits >= 0),
  funding_xlm numeric(18,7) NOT NULL DEFAULT 0 CHECK (funding_xlm >= 0),
  management_xlm numeric(18,7) NOT NULL DEFAULT 0,
  registration_fee_waived boolean NOT NULL DEFAULT false,
  registration_fee_paid_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());

-- Append-only record of every credit and pot movement, the evidence reconciliation checks against the chain.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  event text NOT NULL CHECK (event IN ('bundle_credit','registration_fee','activation_draw','activation_refund','management_charge','fee_sweep','adjustment')),
  plan text CHECK (plan IS NULL OR plan IN ('monthly','annual')),
  annual_credits_delta integer NOT NULL DEFAULT 0,
  monthly_credits_delta integer NOT NULL DEFAULT 0,
  funding_delta_xlm numeric(18,7) NOT NULL DEFAULT 0,
  management_delta_xlm numeric(18,7) NOT NULL DEFAULT 0,
  fee_xlm numeric(18,7) NOT NULL DEFAULT 0 CHECK (fee_xlm >= 0),
  bundle_slug text,
  reference text CHECK (reference IS NULL OR length(reference) <= 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 80),
  CONSTRAINT credit_ledger_once UNIQUE (tenant_id, idempotency_key));
CREATE INDEX IF NOT EXISTS idx_credit_ledger_tenant_time ON credit_ledger (tenant_id, created_at);

-- Which credit paid for each wallet, when an annual year ends, and when a wallet was deleted (manual escalation only).
ALTER TABLE wallet_activations
  ADD COLUMN IF NOT EXISTS credit_plan text,
  ADD COLUMN IF NOT EXISTS management_paid_until timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE wallet_activations DROP CONSTRAINT IF EXISTS wallet_activations_credit_plan;
ALTER TABLE wallet_activations ADD CONSTRAINT wallet_activations_credit_plan
  CHECK ((credit_plan IS NULL AND management_paid_until IS NULL)
      OR (credit_plan = 'monthly' AND management_paid_until IS NULL)
      OR (credit_plan = 'annual' AND management_paid_until IS NOT NULL));
