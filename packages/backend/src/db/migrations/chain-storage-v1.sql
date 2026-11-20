-- Run only through migrate-chain-storage.ts, in one transaction.
-- This targeted migration does not replay or modify the historical Drizzle journal.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_wallets','tx_history','address_book','portfolio_snapshots'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'Missing baseline table: %', t;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='chain') THEN
      RAISE EXCEPTION 'Unrecognized chain schema in %. Reconcile before migration.', t;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM user_wallets WHERE network IS NULL OR network NOT IN ('public','mainnet','pubnet','testnet')) THEN
    RAISE EXCEPTION 'Unknown wallet network; operator reconciliation required';
  END IF;
  IF EXISTS (SELECT 1 FROM user_wallets GROUP BY user_id, CASE WHEN network IN ('mainnet','pubnet') THEN 'public' ELSE network END, public_key HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Wallet network normalization causes duplicate identities';
  END IF;
  IF EXISTS (SELECT 1 FROM user_wallets WHERE is_active=true GROUP BY user_id, CASE WHEN network IN ('mainnet','pubnet') THEN 'public' ELSE network END HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Multiple active wallets in one user/network; reconcile explicitly';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='user_wallets' AND indexname='idx_user_wallets_user_pubkey' AND indexdef LIKE 'CREATE UNIQUE INDEX% (user_id, public_key)') THEN
    RAISE EXCEPTION 'Unexpected wallet identity index; reconcile schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.tx_history'::regclass AND conname='tx_history_tx_hash_unique' AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (tx_hash)') THEN
    RAISE EXCEPTION 'Unexpected transaction hash constraint; reconcile schema';
  END IF;
END $$;

LOCK TABLE user_wallets, tx_history, address_book, portfolio_snapshots IN ACCESS EXCLUSIVE MODE;
ALTER TABLE user_wallets ADD COLUMN chain text NOT NULL DEFAULT 'stellar';
UPDATE user_wallets SET network='public' WHERE network IN ('mainnet','pubnet');
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_chain_network_check CHECK (
  (chain='stellar' AND network IN ('public','testnet')) OR (chain='xrpl' AND network IS NOT NULL AND network IN ('mainnet','testnet'))
);
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_xrpl_no_secret CHECK (chain <> 'xrpl' OR encrypted_secret IS NULL);
CREATE UNIQUE INDEX idx_user_wallets_identity ON user_wallets (user_id, chain, network, public_key);
CREATE UNIQUE INDEX idx_user_wallets_active ON user_wallets (user_id, chain, network) WHERE is_active=true;
DROP INDEX idx_user_wallets_user_pubkey;

ALTER TABLE tx_history ADD COLUMN chain text NOT NULL DEFAULT 'stellar';
-- Do not invent a network for historical rows without ingestion provenance.
ALTER TABLE tx_history ADD COLUMN network text;
ALTER TABLE tx_history ADD CONSTRAINT tx_history_chain_network_check CHECK (
  (chain='stellar' AND (network IS NULL OR network IN ('public','testnet'))) OR (chain='xrpl' AND network IS NOT NULL AND network IN ('mainnet','testnet'))
);
CREATE UNIQUE INDEX idx_tx_history_chain_network_hash ON tx_history (chain, coalesce(network, 'unknown'), tx_hash);
ALTER TABLE tx_history DROP CONSTRAINT tx_history_tx_hash_unique;

ALTER TABLE address_book ADD COLUMN chain text NOT NULL DEFAULT 'stellar';
-- Existing contacts are Stellar-wide, not tied to an inferred network.
ALTER TABLE address_book ADD COLUMN network text;
ALTER TABLE address_book ADD CONSTRAINT address_book_chain_network_check CHECK (
  (chain='stellar' AND (network IS NULL OR network IN ('public','testnet'))) OR (chain='xrpl' AND network IS NOT NULL AND network IN ('mainnet','testnet'))
);
ALTER TABLE portfolio_snapshots ADD COLUMN chain text NOT NULL DEFAULT 'stellar';
ALTER TABLE portfolio_snapshots ADD COLUMN network text;
-- This XLM-denominated table remains Stellar-only; XRP needs separate analytics.
ALTER TABLE portfolio_snapshots ADD CONSTRAINT portfolio_snapshots_stellar_check CHECK (chain='stellar' AND (network IS NULL OR network IN ('public','testnet')));
