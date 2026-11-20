-- Additive evolution of the released payment schema. Do not edit payments-v1.
DO $$ BEGIN
  IF to_regclass('public.xrpl_payments') IS NULL OR EXISTS
    (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='xrpl_payments' AND column_name IN ('lease_token','reconciliation_evidence')) THEN
    RAISE EXCEPTION 'Unexpected reconciliation schema; reconcile before applying';
  END IF;
END $$;
ALTER TABLE xrpl_payments
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN next_reconcile_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN reconcile_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN broadcast_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_broadcast_at timestamptz,
  ADD COLUMN last_checked_ledger bigint,
  ADD COLUMN last_checked_ledger_hash varchar(64),
  ADD COLUMN reconciliation_evidence jsonb;
ALTER TABLE xrpl_payments DROP CONSTRAINT xrpl_payments_state;
ALTER TABLE xrpl_payments ADD CONSTRAINT xrpl_payments_state CHECK (state IN ('awaiting_approval','prepared','signed','submitted','validated_success','validated_failure','expired','cancelled'));
ALTER TABLE xrpl_payments DROP CONSTRAINT xrpl_payments_signature;
ALTER TABLE xrpl_payments ADD CONSTRAINT xrpl_payments_signature CHECK (
  (state IN ('signed','submitted','validated_success','validated_failure') AND signed_blob IS NOT NULL AND transaction_hash IS NOT NULL) OR
  (state IN ('awaiting_approval','prepared','cancelled') AND signed_blob IS NULL AND transaction_hash IS NULL) OR
  (state='expired' AND ((signed_blob IS NULL AND transaction_hash IS NULL) OR (signed_blob IS NOT NULL AND transaction_hash IS NOT NULL)))
);
ALTER TABLE xrpl_payments ADD CONSTRAINT xrpl_payments_expiry CHECK (state<>'expired' OR (reconciliation_evidence IS NOT NULL AND coalesce(reconciliation_evidence->>'status'='expired' AND reconciliation_evidence->>'code'='NON_INCLUSION_PROVEN',false)));
ALTER TABLE xrpl_payments ADD CONSTRAINT xrpl_payments_lease CHECK ((lease_token IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL));
ALTER TABLE xrpl_payments ADD CONSTRAINT xrpl_payments_retries CHECK (reconcile_attempts>=0 AND reconcile_failures BETWEEN 0 AND 30 AND broadcast_attempts BETWEEN 0 AND 8);
CREATE INDEX idx_xrpl_payment_reconciliation_queue ON xrpl_payments(next_reconcile_at,lease_expires_at) WHERE state IN ('prepared','signed','submitted');
