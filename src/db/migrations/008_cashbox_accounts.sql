-- ============================================================
-- Migration 008: Link cashboxes to ledger accounts and allow cashbox transfers
-- ============================================================

ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT;

UPDATE cashboxes
SET account_id = 'acc_cash'
WHERE account_id IS NULL
  AND id = (SELECT id FROM cashboxes ORDER BY created_at, id LIMIT 1);

ALTER TABLE cash_transactions DROP CONSTRAINT IF EXISTS cash_transactions_type_check;
ALTER TABLE cash_transactions ADD CONSTRAINT cash_transactions_type_check
  CHECK (type IN ('receipt','payment','deposit','withdrawal','opening','transfer_out','transfer_in'));

INSERT INTO schema_migrations (id) VALUES ('008_cashbox_accounts') ON CONFLICT (id) DO NOTHING;
