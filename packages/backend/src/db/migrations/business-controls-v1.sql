-- Run only through migrate-business-controls-v1.ts, in one transaction.
-- Business balance floor and controls (owner decisions of 16 Nov 2026, stage 5):
--   - each day the management pot is compared with its floor (2 months of wallet fees, with growth). Below it, the business
--     and the owner are warned; after 7 days below, new activations stop (learners keep their wallets). Back above, they resume.
--   - a business can pause and resume its own activations.
--   - every warning and control change is kept as a business alert.
CREATE TABLE IF NOT EXISTS business_activation_controls (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  paused_at timestamptz,
  paused_by text CHECK (paused_by IS NULL OR length(paused_by) BETWEEN 1 AND 80),
  floor_xlm numeric(18,7) CHECK (floor_xlm IS NULL OR floor_xlm >= 0),
  management_xlm numeric(18,7),
  floor_checked_at timestamptz,
  below_floor_since timestamptz,
  floor_hold_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_controls_paused_by CHECK ((paused_at IS NULL) = (paused_by IS NULL)),
  CONSTRAINT business_controls_hold CHECK (floor_hold_since IS NULL OR below_floor_since IS NOT NULL));

CREATE TABLE IF NOT EXISTS business_alerts (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('floor_warning','floor_hold','floor_cleared','low_balance','paused','resumed','daily_cap_changed')),
  detail jsonb NOT NULL DEFAULT '{}',
  sent_to text[] NOT NULL DEFAULT '{}',
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_business_alerts_recent ON business_alerts (tenant_id, kind, created_at DESC);
