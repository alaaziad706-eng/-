const crypto = require('crypto');
const { UserFacingError } = require('../errors');
const { audit } = require('../domain/audit');
const { assertIsoDate, requireText, optionalText, toMilli, toPiastres, mulDivRound } = require('../domain/money');
const { postJournalEntry } = require('../domain/postingEngine');

const PRODUCT_CATEGORIES = ['feed', 'supplies', 'medication', 'spare_parts', 'other'];
const DEFAULT_WAREHOUSE = 'wh_main';
const LIST_LIMIT = 300;

function readProduct(db, productId) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new UserFacingError('الصنف غير موجود');
  return product;
}

function requireWarehouse(db, warehouseId = DEFAULT_WAREHOUSE) {
  const warehouse = db.prepare('SELECT id, name FROM warehouses WHERE id = ? AND is_active = 1').get(String(warehouseId));
  if (!warehouse) throw new UserFacingError('المخزن غير موجود أو غير مفعّل');
  return warehouse;
}

function readBalance(db, productId, warehouseId) {
  return db.prepare('SELECT quantity_milli, total_value FROM stock_balances WHERE product_id = ? AND warehouse_id = ?')
    .get(productId, warehouseId) ?? { quantity_milli: 0, total_value: 0 };
}

// الرصيد لكل مخزن هو المصدر؛ مجموع الأرصدة يُحفظ في الصنف لعرضه وللتنبيهات
function applyBalanceChange(db, productId, warehouseId, quantityDelta, valueDelta) {
  if (quantityDelta > 0) {
    db.prepare(`
      INSERT INTO stock_balances (product_id, warehouse_id, quantity_milli, total_value) VALUES (?, ?, ?, ?)
      ON CONFLICT (product_id, warehouse_id) DO UPDATE SET
        quantity_milli = quantity_milli + excluded.quantity_milli,
        total_value = total_value + excluded.total_value
    `).run(productId, warehouseId, quantityDelta, valueDelta);
  } else {
    db.prepare('UPDATE stock_balances SET quantity_milli = quantity_milli + ?, total_value = total_value + ? WHERE product_id = ? AND warehouse_id = ?')
      .run(quantityDelta, valueDelta, productId, warehouseId);
  }
  db.prepare('UPDATE products SET quantity_milli = quantity_milli + ?, total_value = total_value + ?, updated_at = ? WHERE id = ?')
    .run(quantityDelta, valueDelta, new Date().toISOString(), productId);
}

function assertPositiveMilli(value, label = 'الكمية') {
  if (!Number.isSafeInteger(value) || value <= 0) throw new UserFacingError(`${label} غير صالحة`);
  return value;
}

function parseProductInput(db, input, currentId) {
  const name = requireText(input?.name, 'اسم الصنف', 120);
  const category = input?.category ?? 'supplies';
  if (!PRODUCT_CATEGORIES.includes(category)) throw new UserFacingError('تصنيف الصنف غير صالح');
  const unit = requireText(input?.unit ?? 'وحدة', 'الوحدة', 30);
  const reorderLevelMilli = toMilli(input?.reorderLevel ?? 0, 'حد إعادة الطلب', { allowZero: true });
  const sku = optionalText(input?.sku, 40);
  if (sku && db.prepare('SELECT id FROM products WHERE sku = ? AND id <> ?').get(sku, currentId ?? '')) {
    throw new UserFacingError('رمز الصنف مستخدم بالفعل');
  }
  return { name, category, unit, reorderLevelMilli, sku };
}

function listProducts(db) {
  return db.prepare(`
    SELECT id, name, sku, category, unit, reorder_level_milli, quantity_milli, total_value, is_active,
      CASE WHEN quantity_milli = 0 THEN 0 ELSE CAST(ROUND(total_value * 1000.0 / quantity_milli) AS INTEGER) END AS unit_cost,
      CASE WHEN quantity_milli <= reorder_level_milli AND reorder_level_milli > 0 THEN 1 ELSE 0 END AS is_low_stock
    FROM products WHERE is_active = 1 ORDER BY name
  `).all().map((row) => ({ ...row, is_active: row.is_active === 1, is_low_stock: row.is_low_stock === 1 }));
}

function listStockBalances(db, warehouseId) {
  const warehouse = requireWarehouse(db, warehouseId);
  return db.prepare(`
    SELECT p.id AS product_id, p.name AS product_name, p.unit, b.quantity_milli, b.total_value
    FROM stock_balances b JOIN products p ON p.id = b.product_id
    WHERE b.warehouse_id = ? AND b.quantity_milli > 0 ORDER BY p.name
  `).all(warehouse.id);
}

function listWarehouses(db) {
  return db.prepare('SELECT id, name, is_default FROM warehouses WHERE is_active = 1 ORDER BY is_default DESC, name')
    .all().map((row) => ({ ...row, is_default: row.is_default === 1 }));
}

function createWarehouse(db, userId, input) {
  const name = requireText(input?.name, 'اسم المخزن', 80);
  if (db.prepare('SELECT id FROM warehouses WHERE name = ?').get(name)) throw new UserFacingError('اسم المخزن مستخدم بالفعل');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO warehouses (id, name, is_default) VALUES (?, ?, 0)').run(id, name);
  audit(db, { userId, action: 'create', module: 'inventory', entityId: id, entityType: 'warehouse', details: { name } });
  return { id };
}

function createProduct(db, userId, input) {
  const fields = parseProductInput(db, input);
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO products (id, name, sku, category, unit, reorder_level_milli, account_id)
    VALUES (?, ?, ?, ?, ?, ?, 'acc_inventory')
  `).run(id, fields.name, fields.sku, fields.category, fields.unit, fields.reorderLevelMilli);
  audit(db, { userId, action: 'create', module: 'inventory', entityId: id, entityType: 'product', details: { name: fields.name } });
  return { id };
}

function updateProduct(db, userId, input) {
  const product = readProduct(db, String(input?.id ?? ''));
  const fields = parseProductInput(db, input, product.id);
  db.prepare(`
    UPDATE products SET name = ?, sku = ?, category = ?, unit = ?, reorder_level_milli = ?, updated_at = ? WHERE id = ?
  `).run(fields.name, fields.sku, fields.category, fields.unit, fields.reorderLevelMilli, new Date().toISOString(), product.id);
  audit(db, { userId, action: 'update', module: 'inventory', entityId: product.id, entityType: 'product', details: { name: fields.name } });
  return { id: product.id };
}

// يجب استدعاؤها داخل معاملة يملكها المستدعي
function receiveStock(db, {
  date, productId, quantityMilli, totalCost, type = 'purchase', referenceType = null, referenceId = null,
  activityId = null, userId = null, notes = null, warehouseId = DEFAULT_WAREHOUSE,
}) {
  readProduct(db, productId);
  const warehouse = requireWarehouse(db, warehouseId);
  const qty = assertPositiveMilli(quantityMilli);
  const cost = toPiastres(totalCost, 'التكلفة', { allowZero: true });
  const balance = readBalance(db, productId, warehouse.id);
  applyBalanceChange(db, productId, warehouse.id, qty, cost);
  const unitCost = mulDivRound(cost, 1000, qty);
  insertMovement(db, {
    date, productId, warehouseId: warehouse.id, type, direction: 'in', quantityMilli: qty, unitCost, totalCost: cost,
    quantityAfter: balance.quantity_milli + qty, valueAfter: balance.total_value + cost,
    referenceType, referenceId, activityId, userId, notes,
  });
  return { unitCost, totalCost: cost };
}

// يُرجع تكلفة البضاعة المصروفة بالمتوسط المرجح للمخزن؛ آخر وحدة تُخرج تفرغ القيمة بالكامل
function issueStock(db, {
  date, productId, quantityMilli, type = 'sale', referenceType = null, referenceId = null,
  activityId = null, userId = null, notes = null, warehouseId = DEFAULT_WAREHOUSE,
}) {
  const product = readProduct(db, productId);
  const warehouse = requireWarehouse(db, warehouseId);
  const qty = assertPositiveMilli(quantityMilli);
  const balance = readBalance(db, productId, warehouse.id);
  if (qty > balance.quantity_milli) {
    throw new UserFacingError(`الكمية المتاحة من ${product.name} في ${warehouse.name} غير كافية`);
  }
  const cost = qty === balance.quantity_milli
    ? balance.total_value
    : mulDivRound(qty, balance.total_value, balance.quantity_milli);
  applyBalanceChange(db, productId, warehouse.id, -qty, -cost);
  const unitCost = mulDivRound(cost, 1000, qty);
  insertMovement(db, {
    date, productId, warehouseId: warehouse.id, type, direction: 'out', quantityMilli: qty, unitCost, totalCost: cost,
    quantityAfter: balance.quantity_milli - qty, valueAfter: balance.total_value - cost,
    referenceType, referenceId, activityId, userId, notes,
  });
  return { unitCost, totalCost: cost };
}

function insertMovement(db, m) {
  db.prepare(`
    INSERT INTO stock_movements (
      id, date, product_id, warehouse_id, type, direction, quantity_milli, unit_cost, total_cost,
      quantity_after_milli, value_after, reference_type, reference_id, activity_id, notes, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(), m.date, m.productId, m.warehouseId, m.type, m.direction, m.quantityMilli,
    m.unitCost, m.totalCost, m.quantityAfter, m.valueAfter, m.referenceType, m.referenceId,
    m.activityId, m.notes, m.userId,
  );
}

// نقل بين مخزنين: إخراج بالمتوسط في المصدر ثم إدخال بنفس القيمة في الهدف، دون قيد محاسبي لأن الحساب واحد
function transferStock(db, userId, input) {
  const date = assertIsoDate(input?.date);
  const productId = String(input?.productId ?? '');
  const fromId = String(input?.fromWarehouseId ?? '');
  const toId = String(input?.toWarehouseId ?? '');
  if (fromId === toId) throw new UserFacingError('المخزن المحول منه والمحول إليه يجب أن يختلفا');
  const quantityMilli = assertPositiveMilli(toMilli(input?.quantity, 'الكمية'));
  const notes = optionalText(input?.notes, 300);

  return db.transaction(() => {
    const transferId = crypto.randomUUID();
    const out = issueStock(db, {
      date, productId, quantityMilli, type: 'transfer', referenceType: 'stock_transfer', referenceId: transferId,
      userId, notes, warehouseId: fromId,
    });
    receiveStock(db, {
      date, productId, quantityMilli, totalCost: out.totalCost, type: 'transfer', referenceType: 'stock_transfer',
      referenceId: transferId, userId, notes, warehouseId: toId,
    });
    audit(db, { userId, action: 'create', module: 'inventory', entityId: transferId, entityType: 'stock_transfer', details: { productId, quantityMilli } });
    return { id: transferId, totalCost: out.totalCost };
  })();
}

// وارد يدوي بلا فاتورة: تكلفته تُدخل يدويًا، ويُقيَّد الفائض على فروق الجرد لأن المقابل ليس نقدًا ولا دائنين
function recordManualReceipt(db, userId, input) {
  const date = assertIsoDate(input?.date);
  const productId = String(input?.productId ?? '');
  const product = readProduct(db, productId);
  const warehouse = requireWarehouse(db, input?.warehouseId);
  const quantityMilli = assertPositiveMilli(toMilli(input?.quantity, 'الكمية'));
  const unitCost = toPiastres(input?.unitCost, 'تكلفة الوحدة', { allowZero: true });
  const totalCost = mulDivRound(unitCost, quantityMilli, 1000);
  const activityId = input?.activityId ? String(input.activityId) : null;
  const notes = optionalText(input?.notes, 300);

  return db.transaction(() => {
    receiveStock(db, {
      date, productId, quantityMilli, totalCost, type: 'adjustment', referenceType: 'manual_receipt', referenceId: productId,
      activityId, userId, notes, warehouseId: warehouse.id,
    });
    if (totalCost > 0) {
      postJournalEntry(db, {
        date, description: `وارد مخزن يدوي: ${product.name}`, referenceType: 'manual_receipt', referenceId: productId,
        activityId, userId,
        lines: [{ accountId: 'acc_inventory', debit: totalCost }, { accountId: 'acc_inventory_adj', credit: totalCost }],
      });
    }
    return { totalCost };
  })();
}

// صرف يدوي (استهلاك في نشاط): يُقيَّد بتكلفته المتوسطة على مصروفات النشاط
function recordManualIssue(db, userId, input) {
  const date = assertIsoDate(input?.date);
  const productId = String(input?.productId ?? '');
  const product = readProduct(db, productId);
  const warehouse = requireWarehouse(db, input?.warehouseId);
  const quantityMilli = assertPositiveMilli(toMilli(input?.quantity, 'الكمية'));
  const activityId = input?.activityId ? String(input.activityId) : null;
  const notes = optionalText(input?.notes, 300);

  return db.transaction(() => {
    const issued = issueStock(db, {
      date, productId, quantityMilli, type: 'issue', referenceType: 'manual_issue', referenceId: productId,
      activityId, userId, notes, warehouseId: warehouse.id,
    });
    if (issued.totalCost > 0) {
      postJournalEntry(db, {
        date, description: `صرف مخزن: ${product.name}`, referenceType: 'manual_issue', referenceId: productId,
        activityId, userId,
        lines: [{ accountId: 'acc_expenses', debit: issued.totalCost }, { accountId: 'acc_inventory', credit: issued.totalCost }],
      });
    }
    return { totalCost: issued.totalCost };
  })();
}

function listStockMovements(db, { productId = null, warehouseId = null } = {}) {
  return db.prepare(`
    SELECT m.id, m.date, m.type, m.direction, m.quantity_milli, m.unit_cost, m.total_cost,
      m.quantity_after_milli, m.value_after, m.reference_type, m.notes, m.created_at,
      p.id AS product_id, p.name AS product_name, p.unit, w.name AS warehouse_name
    FROM stock_movements m
    JOIN products p ON p.id = m.product_id
    JOIN warehouses w ON w.id = m.warehouse_id
    WHERE (? IS NULL OR m.product_id = ?) AND (? IS NULL OR m.warehouse_id = ?)
    ORDER BY m.date DESC, m.created_at DESC, m.rowid DESC
    LIMIT ${LIST_LIMIT}
  `).all(productId, productId, warehouseId, warehouseId);
}

module.exports = {
  DEFAULT_WAREHOUSE,
  PRODUCT_CATEGORIES,
  requireWarehouse,
  readBalance,
  listProducts,
  listStockBalances,
  listWarehouses,
  createWarehouse,
  createProduct,
  updateProduct,
  receiveStock,
  issueStock,
  transferStock,
  recordManualReceipt,
  recordManualIssue,
  listStockMovements,
};
