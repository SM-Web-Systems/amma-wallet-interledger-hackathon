-- Additive, Testnet-only; run through migrate-xrpl-payments.ts in a transaction.
DO $$ BEGIN
  IF to_regclass('public.user_wallets') IS NULL OR NOT EXISTS
    (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='user_wallets' AND column_name='chain' AND is_nullable='NO')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.user_wallets'::regclass AND conname='user_wallets_xrpl_no_secret') THEN
    RAISE EXCEPTION 'Reviewed chain-storage-v1 schema is required';
  END IF;
  IF to_regclass('public.xrpl_payments') IS NOT NULL OR to_regclass('public.xrpl_payment_events') IS NOT NULL THEN
    RAISE EXCEPTION 'Unrecognized XRP payment tables; reconcile before migration';
  END IF;
END $$;

CREATE TABLE xrpl_payments (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  wallet_id bigint NOT NULL REFERENCES user_wallets(id) ON DELETE RESTRICT,
  chain text NOT NULL DEFAULT 'xrpl', network text NOT NULL DEFAULT 'testnet',
  idempotency_key uuid NOT NULL, request_digest varchar(64) NOT NULL,
  reference uuid NOT NULL, source text NOT NULL, request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_approval',
  preparation_id uuid, preparation jsonb,
  signed_blob text, transaction_hash varchar(64), receipt jsonb,
  result_code text, last_observation text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT xrpl_payments_network CHECK (chain='xrpl' AND network='testnet'),
  CONSTRAINT xrpl_payments_state CHECK (state IN ('awaiting_approval','prepared','signed','submitted','validated_success','validated_failure','cancelled')),
  CONSTRAINT xrpl_payments_preparation CHECK ((state IN ('awaiting_approval','cancelled') AND preparation IS NULL AND preparation_id IS NULL) OR (state NOT IN ('awaiting_approval','cancelled') AND preparation IS NOT NULL AND preparation_id IS NOT NULL)),
  CONSTRAINT xrpl_payments_signature CHECK ((state IN ('signed','submitted','validated_success','validated_failure') AND signed_blob IS NOT NULL AND transaction_hash IS NOT NULL) OR (state IN ('awaiting_approval','prepared','cancelled') AND signed_blob IS NULL AND transaction_hash IS NULL)),
  CONSTRAINT xrpl_payments_blob CHECK (signed_blob IS NULL OR (length(signed_blob) BETWEEN 100 AND 4096 AND length(signed_blob)%2=0 AND signed_blob ~ '^[A-F0-9]+$')),
  CONSTRAINT xrpl_payments_hash CHECK (transaction_hash IS NULL OR transaction_hash ~ '^[A-F0-9]{64}$'),
  CONSTRAINT xrpl_payments_digest CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT xrpl_payments_receipt CHECK ((state='validated_success' AND receipt IS NOT NULL AND result_code='tesSUCCESS') OR (state<>'validated_success' AND receipt IS NULL))
);
CREATE UNIQUE INDEX idx_xrpl_payment_idempotency ON xrpl_payments(user_id,chain,network,idempotency_key);
CREATE UNIQUE INDEX idx_xrpl_payment_reference ON xrpl_payments(user_id,chain,network,reference);
CREATE UNIQUE INDEX idx_xrpl_payment_preparation ON xrpl_payments(preparation_id);
CREATE UNIQUE INDEX idx_xrpl_payment_hash ON xrpl_payments(chain,network,transaction_hash);
-- Public metadata is not proof of key control. Unsigned preparations cannot
-- reserve another user's source globally; only a verified signature can.
CREATE UNIQUE INDEX idx_xrpl_payment_owner_source ON xrpl_payments(user_id,chain,network,source) WHERE state IN ('prepared','signed','submitted');
CREATE UNIQUE INDEX idx_xrpl_payment_active_source ON xrpl_payments(chain,network,source) WHERE state IN ('signed','submitted');
CREATE INDEX idx_xrpl_payment_owner ON xrpl_payments(user_id,wallet_id,created_at);

CREATE TABLE xrpl_payment_events (
  id bigserial PRIMARY KEY, intent_id uuid NOT NULL REFERENCES xrpl_payments(id) ON DELETE RESTRICT,
  from_state text, to_state text NOT NULL, code text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_xrpl_payment_event_intent ON xrpl_payment_events(intent_id,id);
