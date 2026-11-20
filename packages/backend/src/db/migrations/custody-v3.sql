CREATE TABLE IF NOT EXISTS custody_evm_transfers (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  from_address text NOT NULL,
  to_address text NOT NULL,
  value_wei text NOT NULL CHECK (value_wei ~ '^[1-9][0-9]{0,40}$'),
  nonce integer NOT NULL CHECK (nonce >= 0),
  max_fee_wei text NOT NULL DEFAULT '0' CHECK (max_fee_wei ~ '^[0-9]{1,40}$'),
  hash text NOT NULL CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('signed','broadcast','confirmed','failed')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custody_evm_transfers_hash_key UNIQUE (hash),
  CONSTRAINT custody_evm_transfers_idem_key UNIQUE (user_id, idempotency_key));
CREATE INDEX IF NOT EXISTS idx_custody_evm_transfers_from ON custody_evm_transfers (user_id, from_address, created_at);
