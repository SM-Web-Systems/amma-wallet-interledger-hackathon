CREATE TABLE IF NOT EXISTS payment_accounts (
 id uuid PRIMARY KEY, owner_id bigint NOT NULL, asset_key text NOT NULL, asset jsonb NOT NULL,
 kind text NOT NULL CHECK (kind IN ('customer','reserved','clearing','fees')),
 reference text NOT NULL, balance numeric(78,0) NOT NULL DEFAULT 0,
 CHECK (kind IN ('clearing','fees') OR balance >= 0),
 UNIQUE(owner_id,asset_key,kind,reference), UNIQUE(id,asset_key)
);
-- Each immutable row contains both sides of a balanced posting in one asset.
CREATE TABLE IF NOT EXISTS payment_ledger (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE, asset_key text NOT NULL,
 debit_account uuid NOT NULL, credit_account uuid NOT NULL,
 amount numeric(78,0) NOT NULL CHECK (amount > 0), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(debit_account <> credit_account),
 FOREIGN KEY(debit_account,asset_key) REFERENCES payment_accounts(id,asset_key),
 FOREIGN KEY(credit_account,asset_key) REFERENCES payment_accounts(id,asset_key)
);
CREATE OR REPLACE FUNCTION payment_ledger_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'payment ledger is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS payment_ledger_no_rewrite ON payment_ledger;
CREATE TRIGGER payment_ledger_no_rewrite BEFORE UPDATE OR DELETE ON payment_ledger
 FOR EACH ROW EXECUTE FUNCTION payment_ledger_immutable();
CREATE TABLE IF NOT EXISTS payment_documents (
 kind text NOT NULL, id uuid NOT NULL, owner_id bigint NOT NULL, body jsonb NOT NULL,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(kind,id)
);
CREATE INDEX IF NOT EXISTS payment_documents_owner ON payment_documents(owner_id,kind);
CREATE TABLE IF NOT EXISTS payment_invoice_claims (
 invoice_id uuid PRIMARY KEY, execution_id uuid NOT NULL UNIQUE, owner_id bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_spend_limits (
 owner_id bigint NOT NULL, asset_key text NOT NULL, day date NOT NULL, committed numeric(78,0) NOT NULL CHECK(committed>=0),
 PRIMARY KEY(owner_id,asset_key,day)
);
CREATE TABLE IF NOT EXISTS payment_idempotency (
 owner_id bigint NOT NULL, operation text NOT NULL, key uuid NOT NULL, digest text NOT NULL, result_id uuid NOT NULL,
 PRIMARY KEY(owner_id,operation,key)
);
CREATE TABLE IF NOT EXISTS payment_jobs (
 id uuid PRIMARY KEY, owner_id bigint NOT NULL, kind text NOT NULL, body jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','done','review')),
 lease uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 next_attempt timestamptz NOT NULL DEFAULT now(), last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_webhooks (
 id uuid PRIMARY KEY, digest text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_wallet_addresses (
 url text PRIMARY KEY, owner_id bigint NOT NULL, account_id uuid NOT NULL REFERENCES payment_accounts(id),
 rafiki_id text NOT NULL UNIQUE, asset_key text NOT NULL
);
