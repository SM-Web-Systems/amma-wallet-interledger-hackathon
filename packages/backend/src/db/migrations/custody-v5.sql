-- Run only through migrate-custody-v5.ts, in one transaction.
-- Mainnet custody mode (MAINNET_CUSTODY=on): Amma-held Ethereum wallets may live on 'ethereum' as well as 'sepolia'.
ALTER TABLE user_wallets DROP CONSTRAINT IF EXISTS user_wallets_chain_network_check;
ALTER TABLE user_wallets ADD CONSTRAINT user_wallets_chain_network_check CHECK (
  (chain = 'stellar' AND network IN ('public','testnet')) OR
  (chain = 'xrpl' AND network IS NOT NULL AND network IN ('mainnet','testnet')) OR
  (chain = 'evm' AND network IN ('sepolia','ethereum')));
