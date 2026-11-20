-- XRP payments for Amma-held wallets on mainnet (XRPL_MAINNET_CUSTODY=on only). Widens the payment network to testnet or mainnet.
-- Receipt claims (tenant integrations) stay testnet-only. Do not edit the released payment, reconciliation or integration migrations.
DO $$ BEGIN
  IF to_regclass('public.xrpl_payments') IS NULL OR NOT EXISTS
    (SELECT 1 FROM pg_constraint WHERE conrelid='public.xrpl_payments'::regclass AND conname='xrpl_payments_network'
      AND pg_get_constraintdef(oid) ~ 'network = ''testnet''') THEN
    RAISE EXCEPTION 'Unexpected XRP payment network constraint; reconcile before applying';
  END IF;
END $$;
ALTER TABLE xrpl_payments DROP CONSTRAINT xrpl_payments_network;
ALTER TABLE xrpl_payments ADD CONSTRAINT xrpl_payments_network CHECK (chain='xrpl' AND network IN ('testnet','mainnet'));
