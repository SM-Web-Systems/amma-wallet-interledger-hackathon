ALTER TABLE user_wallets DROP CONSTRAINT IF EXISTS user_wallets_chain_network_check;
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_chain_network_check CHECK (
  (chain = 'stellar' AND network IN ('public','testnet')) OR
  (chain = 'xrpl' AND network IS NOT NULL AND network IN ('mainnet','testnet')) OR
  (chain = 'evm' AND network = 'sepolia'));
ALTER TABLE user_wallets DROP CONSTRAINT IF EXISTS user_wallets_evm_no_secret;
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_evm_no_secret CHECK (chain <> 'evm' OR encrypted_secret IS NULL);
CREATE TABLE IF NOT EXISTS welcome_funding (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain text NOT NULL CHECK (chain IN ('stellar','xrpl','evm')),
  address text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','sent','confirmed','failed','skipped')),
  amount text, reference text, error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, chain));
CREATE INDEX IF NOT EXISTS idx_welcome_funding_created ON welcome_funding (created_at);

ALTER TABLE wallet_key_escrow ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'client';
ALTER TABLE wallet_key_escrow DROP CONSTRAINT IF EXISTS wallet_key_escrow_origin_check;
ALTER TABLE wallet_key_escrow ADD CONSTRAINT wallet_key_escrow_origin_check CHECK (origin IN ('client','custody'));
