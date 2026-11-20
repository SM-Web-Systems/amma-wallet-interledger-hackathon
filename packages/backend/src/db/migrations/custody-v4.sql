-- Run only through migrate-custody-v4.ts, in one transaction.
-- Device-only wallets moved into Amma's escrow: one sealed secret per imported wallet (kind "import:<chain>:<address>", origin "import").
ALTER TABLE wallet_key_escrow DROP CONSTRAINT IF EXISTS wallet_key_escrow_kind_check;
ALTER TABLE wallet_key_escrow ADD CONSTRAINT wallet_key_escrow_kind_check CHECK (
  kind IN ('phrase','stellar-secret') OR kind ~ '^import:(stellar|xrpl|evm):[A-Za-z0-9]{20,64}$');
ALTER TABLE wallet_key_escrow DROP CONSTRAINT IF EXISTS wallet_key_escrow_origin_check;
ALTER TABLE wallet_key_escrow ADD CONSTRAINT wallet_key_escrow_origin_check CHECK (origin IN ('client','custody','import'));
