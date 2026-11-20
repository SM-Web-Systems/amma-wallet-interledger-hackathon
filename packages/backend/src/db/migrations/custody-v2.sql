ALTER TABLE user_wallets ADD COLUMN IF NOT EXISTS derivation_index integer;
ALTER TABLE user_wallets DROP CONSTRAINT IF EXISTS user_wallets_derivation_index_check;
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_derivation_index_check CHECK (derivation_index IS NULL OR (derivation_index >= 0 AND derivation_index <= 9));
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_wallets_derivation ON user_wallets (user_id, chain, network, derivation_index) WHERE derivation_index IS NOT NULL;
DO $custody_v2$
BEGIN
  IF EXISTS (
    SELECT 1 FROM user_wallets uw
    WHERE uw.derivation_index IS NULL AND uw.encrypted_secret IS NULL
      AND ((uw.chain = 'stellar' AND uw.network = 'testnet' AND uw.name = 'Amma Stellar')
        OR (uw.chain = 'xrpl' AND uw.network = 'testnet' AND uw.name = 'Amma XRP')
        OR (uw.chain = 'evm' AND uw.network = 'sepolia' AND uw.name = 'Amma Ethereum'))
      AND EXISTS (SELECT 1 FROM wallet_key_escrow e WHERE e.user_id = uw.user_id AND e.origin = 'custody')
    GROUP BY uw.user_id, uw.chain, uw.network HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'custody-v2 backfill is ambiguous: a custody user has more than one onboarding wallet row for a chain';
  END IF;
  UPDATE user_wallets uw SET derivation_index = 0
  WHERE uw.derivation_index IS NULL AND uw.encrypted_secret IS NULL
    AND ((uw.chain = 'stellar' AND uw.network = 'testnet' AND uw.name = 'Amma Stellar')
      OR (uw.chain = 'xrpl' AND uw.network = 'testnet' AND uw.name = 'Amma XRP')
      OR (uw.chain = 'evm' AND uw.network = 'sepolia' AND uw.name = 'Amma Ethereum'))
    AND EXISTS (SELECT 1 FROM wallet_key_escrow e WHERE e.user_id = uw.user_id AND e.origin = 'custody');
END
$custody_v2$;
