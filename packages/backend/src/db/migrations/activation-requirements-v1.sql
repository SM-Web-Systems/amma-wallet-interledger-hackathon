-- Run only through migrate-activation-requirements-v1.ts, in one transaction.
-- Activation requirement per task (owner decisions of 16 Nov 2026, stage 4): a task is either "signed call only" (the partner's
-- signed call is enough, as before) or "holds an NFT from contract X on network Y", which Amma checks on-chain before any XLM
-- is sent. Every existing task keeps today's behaviour (signed_call).
ALTER TABLE partner_tasks
  ADD COLUMN IF NOT EXISTS requirement_kind text NOT NULL DEFAULT 'signed_call',
  ADD COLUMN IF NOT EXISTS requirement_contract text,
  ADD COLUMN IF NOT EXISTS requirement_network text;
ALTER TABLE partner_tasks DROP CONSTRAINT IF EXISTS partner_tasks_requirement;
ALTER TABLE partner_tasks ADD CONSTRAINT partner_tasks_requirement CHECK (
  (requirement_kind = 'signed_call' AND requirement_contract IS NULL AND requirement_network IS NULL)
  OR (requirement_kind = 'holds_nft' AND requirement_contract IS NOT NULL AND requirement_contract ~ '^C[A-Z2-7]{55}$'
      AND requirement_network IS NOT NULL AND requirement_network IN ('public','testnet')));
