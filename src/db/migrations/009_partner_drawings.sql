-- ============================================================
-- Migration 009: Partner drawings account and cash movement type
-- ============================================================

INSERT INTO accounts (id, code, name, type, parent_id, is_system) VALUES
  ('acc_partner_drawings', '303', 'مسحوبات الشريك', 'equity', 'acc_equity', true)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE cash_transactions DROP CONSTRAINT IF EXISTS cash_transactions_type_check;
ALTER TABLE cash_transactions ADD CONSTRAINT cash_transactions_type_check
  CHECK (type IN ('receipt','payment','deposit','withdrawal','opening','transfer_out','transfer_in','partner_drawing'));

INSERT INTO schema_migrations (id) VALUES ('009_partner_drawings') ON CONFLICT (id) DO NOTHING;
