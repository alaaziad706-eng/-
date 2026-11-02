const crypto = require('crypto');
const { UserFacingError } = require('../errors');
const { audit } = require('../domain/audit');
const { assertIsoDate, optionalText, toMilli, toPiastres, mulDivRound } = require('../domain/money');
const { nextDocNumber, postJournalEntry } = require('../domain/postingEngine');
const { DEFAULT_WAREHOUSE, requireWarehouse, readBalance, receiveStock, issueStock } = require('./inventoryService');

// الجرد يقارن الكمية الفعلية برصيد المخزن، ويُرحَّل الفرق كاملًا بقيد واحد على حساب فروق الجرد (521)
// الفائض يُقيَّم بالمتوسط الحالي للمخزن، وإن كان المخزن فارغًا فبتكلفة يُدخلها المستخدم
function recordStockCount(db, userId, input) {
  const date = assertIsoDate(input?.date);
  const notes = optionalText(input?.notes, 300);
  const warehouse = requireWarehouse(db, input?.warehouseId ?? DEFAULT_WAREHOUSE);
  if (!Array.isArray(input?.items) || input.items.length === 0) throw new UserFacingError('أدخل صنفًا واحدًا على الأقل للجرد');

  const seen = new Set();
  const counted = input.items.map((raw) => {
    const productId = String(raw?.productId ?? '');
    if (seen.has(productId)) throw new UserFacingError('الصنف مكرر في الجرد');
    seen.add(productId);
    const product = db.prepare('SELECT id, name FROM products WHERE id = ? AND is_active = 1').get(productId);
    if (!product) throw new UserFacingError('الصنف غير موجود');
    const countedQty = toMilli(raw?.countedQuantity, 'الكمية الفعلية', { allowZero: true });
    const balance = readBalance(db, product.id, warehouse.id);
    return {
      product, systemQty: balance.quantity_milli, systemValue: balance.total_value, countedQty,
      difference: countedQty - balance.quantity_milli, rawUnitCost: raw?.unitCost,
    };
  });

  return db.transaction(() => {
    const countId = crypto.randomUUID();
    const docNumber = nextDocNumber(db, 'stock_adjustment');
    let gains = 0;
    let losses = 0;
    const applied = counted.map((line) => {
      if (line.difference === 0) return { ...line, unitCost: 0 };
      if (line.difference > 0) {
        const cost = line.systemQty === 0
          ? mulDivRound(line.difference, toPiastres(line.rawUnitCost, 'تكلفة الوحدة', { allowZero: true }), 1000)
          : mulDivRound(line.difference, line.systemValue, line.systemQty);
        const received = receiveStock(db, {
          date, productId: line.product.id, quantityMilli: line.difference, totalCost: cost,
          type: 'count', referenceType: 'stock_count', referenceId: countId, notes, userId, warehouseId: warehouse.id,
        });
        gains += received.totalCost;
        return { ...line, unitCost: received.unitCost };
      }
      const issued = issueStock(db, {
        date, productId: line.product.id, quantityMilli: -line.difference, type: 'count',
        referenceType: 'stock_count', referenceId: countId, notes, userId, warehouseId: warehouse.id,
      });
      losses += issued.totalCost;
      return { ...line, unitCost: issued.unitCost };
    });

    if (gains > 0 || losses > 0) {
      const lines = [];
      if (gains > 0) lines.push({ accountId: 'acc_inventory', debit: gains }, { accountId: 'acc_inventory_adj', credit: gains });
      if (losses > 0) lines.push({ accountId: 'acc_inventory_adj', debit: losses }, { accountId: 'acc_inventory', credit: losses });
      postJournalEntry(db, { date, description: docNumber, referenceType: 'stock_count', referenceId: countId, lines, userId });
    }

    db.prepare(`
      INSERT INTO stock_counts (id, doc_number, date, warehouse_id, status, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(countId, docNumber, date, warehouse.id, gains + losses > 0 ? 'adjusted' : 'completed', notes, userId);
    const insertItem = db.prepare(`
      INSERT INTO stock_count_items (id, count_id, product_id, system_qty_milli, counted_qty_milli, difference_milli, unit_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const line of applied) {
      insertItem.run(crypto.randomUUID(), countId, line.product.id, line.systemQty,
        line.countedQty, line.difference, line.unitCost);
    }
    audit(db, { userId, action: 'create', module: 'inventory', entityId: countId, entityType: 'stock_count', details: { docNumber, gains, losses } });
    return { id: countId, docNumber, gains, losses };
  })();
}

function listStockCounts(db) {
  return db.prepare(`
    SELECT c.id, c.doc_number, c.date, c.status, c.notes, w.name AS warehouse_name
    FROM stock_counts c JOIN warehouses w ON w.id = c.warehouse_id
    ORDER BY c.date DESC, c.doc_number DESC LIMIT 100
  `).all();
}

module.exports = { recordStockCount, listStockCounts };
