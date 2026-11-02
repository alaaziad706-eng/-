-- ============================================================
-- Migration 006: Employee deductions applied to monthly payroll
-- ============================================================

CREATE TABLE IF NOT EXISTS employee_deductions (
  id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  employee_id      TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month            DATE NOT NULL,
  amount           BIGINT NOT NULL CHECK (amount > 0),
  reason           TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  salary_record_id TEXT REFERENCES salary_records(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deduction_emp_month ON employee_deductions(employee_id, month);

INSERT INTO schema_migrations (id) VALUES ('006_employee_deductions') ON CONFLICT (id) DO NOTHING;
