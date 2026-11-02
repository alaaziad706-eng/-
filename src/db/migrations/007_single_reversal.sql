-- ============================================================
-- Migration 007: Each journal entry can be reversed at most once
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_reversal_per_entry
  ON journal_entries(reference_id)
  WHERE reference_type = 'reversal';

INSERT INTO schema_migrations (id) VALUES ('007_single_reversal') ON CONFLICT (id) DO NOTHING;
