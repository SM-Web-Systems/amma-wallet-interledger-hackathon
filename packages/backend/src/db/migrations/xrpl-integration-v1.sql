-- Testnet only. Preserve released payment/reconciliation migrations and evidence.
DO $$ BEGIN
  IF to_regclass('public.tenants') IS NULL OR to_regclass('public.tenant_api_keys') IS NULL
    OR to_regclass('public.tenant_users') IS NULL THEN
    RAISE EXCEPTION 'Reviewed tenant schema is required';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='xrpl_payments' AND column_name IN ('application_tenant_id','application_name'))
    OR to_regclass('public.xrpl_receipt_claims') IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected integration schema; reconcile before migration';
  END IF;
END $$;
ALTER TABLE xrpl_payments
  ADD COLUMN application_tenant_id bigint REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD COLUMN application_name text,
  ADD CONSTRAINT xrpl_payments_application CHECK
    ((application_tenant_id IS NULL AND application_name IS NULL) OR
     (application_tenant_id IS NOT NULL AND application_tenant_id > 0 AND application_name IS NOT NULL AND length(application_name) BETWEEN 1 AND 120));
DROP INDEX idx_xrpl_payment_idempotency;
DROP INDEX idx_xrpl_payment_reference;
CREATE UNIQUE INDEX idx_xrpl_payment_idempotency ON xrpl_payments(user_id,chain,network,coalesce(application_tenant_id,0),idempotency_key);
CREATE UNIQUE INDEX idx_xrpl_payment_reference ON xrpl_payments(user_id,chain,network,coalesce(application_tenant_id,0),reference);

CREATE TABLE xrpl_receipt_claims (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES xrpl_payments(id) ON DELETE RESTRICT,
  application_tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  api_key_id bigint NOT NULL REFERENCES tenant_api_keys(id) ON DELETE RESTRICT,
  chain text NOT NULL DEFAULT 'xrpl', network text NOT NULL DEFAULT 'testnet',
  transaction_hash varchar(64) NOT NULL,
  reference uuid NOT NULL, purchase_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT xrpl_claim_network CHECK (chain='xrpl' AND network='testnet'),
  CONSTRAINT xrpl_claim_hash CHECK (transaction_hash ~ '^[A-F0-9]{64}$'),
  CONSTRAINT xrpl_claim_intent UNIQUE (intent_id),
  CONSTRAINT xrpl_claim_transaction UNIQUE (chain,network,transaction_hash),
  CONSTRAINT xrpl_claim_reference UNIQUE (application_tenant_id,user_id,chain,network,reference),
  -- A tenant purchase is globally single-use, including across different payers.
  CONSTRAINT xrpl_claim_purchase UNIQUE (application_tenant_id,purchase_id)
);
