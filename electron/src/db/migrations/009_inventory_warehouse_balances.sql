-- Migration 009: stock held per warehouse, and a transfer movement type.
-- products.quantity_milli / total_value remain the sum over all warehouses.

CREATE TABLE IF NOT EXISTS stock_balances (
  product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  warehouse_id    TEXT NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  quantity_milli  INTEGER NOT NULL DEFAULT 0 CHECK (quantity_milli >= 0),
  total_value     INTEGER NOT NULL DEFAULT 0 CHECK (total_value >= 0),
  PRIMARY KEY (product_id, warehouse_id),
  CHECK (quantity_milli > 0 OR total_value = 0)
);

INSERT OR IGNORE INTO stock_balances (product_id, warehouse_id, quantity_milli, total_value)
  SELECT id, 'wh_main', quantity_milli, total_value FROM products
  WHERE quantity_milli > 0 OR total_value > 0;

DROP TRIGGER IF EXISTS trg_stock_movements_immutable;
DROP TRIGGER IF EXISTS trg_stock_movements_no_delete;

ALTER TABLE stock_movements RENAME TO stock_movements_old;

CREATE TABLE stock_movements (
  id                   TEXT PRIMARY KEY,
  date                 TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  product_id           TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  warehouse_id         TEXT NOT NULL DEFAULT 'wh_main' REFERENCES warehouses(id) ON DELETE RESTRICT,
  type                 TEXT NOT NULL CHECK (type IN ('purchase','sale','sale_return','purchase_return','issue','adjustment','count','transfer')),
  direction            TEXT NOT NULL CHECK (direction IN ('in','out')),
  quantity_milli       INTEGER NOT NULL CHECK (quantity_milli > 0),
  unit_cost            INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  total_cost           INTEGER NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  quantity_after_milli INTEGER NOT NULL CHECK (quantity_after_milli >= 0),
  value_after          INTEGER NOT NULL CHECK (value_after >= 0),
  reference_type       TEXT,
  reference_id         TEXT,
  activity_id          TEXT REFERENCES activities(id) ON DELETE SET NULL,
  journal_entry_id     TEXT REFERENCES journal_entries(id) ON DELETE RESTRICT,
  notes                TEXT,
  created_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO stock_movements (
  id, date, product_id, warehouse_id, type, direction, quantity_milli, unit_cost, total_cost,
  quantity_after_milli, value_after, reference_type, reference_id, activity_id, journal_entry_id,
  notes, created_by, created_at
)
SELECT
  id, date, product_id, warehouse_id, type, direction, quantity_milli, unit_cost, total_cost,
  quantity_after_milli, value_after, reference_type, reference_id, activity_id, journal_entry_id,
  notes, created_by, created_at
FROM stock_movements_old;

DROP TABLE stock_movements_old;

CREATE INDEX IF NOT EXISTS idx_stockmv_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stockmv_date ON stock_movements(date);
CREATE INDEX IF NOT EXISTS idx_stockmv_reference ON stock_movements(reference_type, reference_id);

CREATE TRIGGER IF NOT EXISTS trg_stock_movements_immutable
BEFORE UPDATE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'حركات المخزون لا يمكن تعديلها');
END;

CREATE TRIGGER IF NOT EXISTS trg_stock_movements_no_delete
BEFORE DELETE ON stock_movements
BEGIN
  SELECT RAISE(ABORT, 'حركات المخزون لا يمكن حذفها');
END;
