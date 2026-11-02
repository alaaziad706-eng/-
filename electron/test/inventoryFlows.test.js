const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db/database');
const { createAuthService } = require('../src/auth/authService');
const { registerFarmHandlers } = require('../src/ipc/farmHandlers');
const { UserFacingError } = require('../src/errors');
const parties = require('../src/services/partyService');
const inventory = require('../src/services/inventoryService');
const counts = require('../src/services/stockCountService');
const invoices = require('../src/services/invoiceService');
const accounting = require('../src/services/accountingService');

const OWNER_KEY = 'owner-session';
let tmpDir;
let db;
let userId;
let supplierId;
let customerId;
let productId;
let secondWarehouseId;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-stock-flows-'));
  db = openDatabase(tmpDir).db;
  const auth = createAuthService(db);
  const owner = await auth.setupOwner('w', { username: 'owner', displayName: 'المالك', password: 'owner-pass-1' });
  userId = owner.id;
  supplierId = parties.createParty(db, userId, { name: 'مورد', type: 'supplier' }).id;
  customerId = parties.createParty(db, userId, { name: 'عميل', type: 'customer' }).id;
  productId = inventory.createProduct(db, userId, { name: 'علف', unit: 'كيس', reorderLevel: 4 }).id;
  secondWarehouseId = inventory.createWarehouse(db, userId, { name: 'مخزن الفرع' }).id;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function balance(warehouseId = 'wh_main', pid = productId) {
  return db.prepare('SELECT quantity_milli AS q, total_value AS v FROM stock_balances WHERE product_id = ? AND warehouse_id = ?')
    .get(pid, warehouseId) ?? { q: 0, v: 0 };
}

function productTotals(pid = productId) {
  return db.prepare('SELECT quantity_milli AS q, total_value AS v FROM products WHERE id = ?').get(pid);
}

function journalCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get().n;
}

function movementCount(referenceId) {
  return db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE reference_id = ?').get(referenceId).n;
}

// يتحقق أن إجمالي كل صنف هو مجموع أرصدة مخازنه، وأن قيمة حساب المخزون في الدفاتر تساوي قيمة المخزون الفعلية
function assertStockIntegrity() {
  const mismatched = db.prepare(`
    SELECT p.id FROM products p LEFT JOIN (
      SELECT product_id, SUM(quantity_milli) AS q, SUM(total_value) AS v FROM stock_balances GROUP BY product_id
    ) b ON b.product_id = p.id
    WHERE p.quantity_milli <> COALESCE(b.q, 0) OR p.total_value <> COALESCE(b.v, 0)
  `).all();
  assert.deepEqual(mismatched, []);
  const stockValue = db.prepare('SELECT COALESCE(SUM(total_value), 0) AS v FROM products').get().v;
  assert.equal(accounting.generalLedger(db, { accountId: 'acc_inventory' }).closing, stockValue);
  assert.equal(accounting.trialBalance(db).isBalanced, true);
}

function purchase(quantity, unitPrice, date = '2024-01-01') {
  return invoices.createInvoice(db, userId, {
    docType: 'purchase', date, partyId: supplierId, paymentMethod: 'credit',
    items: [{ productId, quantity, unitPrice, discount: 0 }],
  });
}

function sale(quantity, unitPrice, date = '2024-01-05') {
  return invoices.createInvoice(db, userId, {
    docType: 'sales', date, partyId: customerId, paymentMethod: 'credit',
    items: [{ productId, quantity, unitPrice, discount: 0 }],
  });
}

test('a purchase invoice adds stock exactly once and the next purchase averages in', () => {
  const first = purchase(10, 5000);
  assert.deepEqual(balance(), { q: 10000, v: 50000 });
  assert.equal(movementCount(first.id), 1);

  purchase(10, 7000);
  assert.deepEqual(balance(), { q: 20000, v: 120000 });
  assert.deepEqual(productTotals(), { q: 20000, v: 120000 });
  assertStockIntegrity();
});

test('a sale issues stock at the weighted average and reduces value by the cost of goods sold', () => {
  purchase(10, 5000);
  purchase(10, 7000);
  const invoice = sale(5, 9000);
  assert.equal(movementCount(invoice.id), 1);
  assert.deepEqual(balance(), { q: 15000, v: 90000 });
  const issue = db.prepare("SELECT total_cost, unit_cost FROM stock_movements WHERE reference_id = ? AND direction = 'out'").get(invoice.id);
  assert.equal(issue.total_cost, 30000);
  assert.equal(issue.unit_cost, 6000);
  assertStockIntegrity();
});

test('a sales return brings stock back at the cost it left with, and a purchase return leaves at the average', () => {
  const buy = purchase(10, 5000);
  const sold = sale(5, 9000);
  const salesReturn = invoices.createReturn(db, userId, {
    returnType: 'sales_return', invoiceId: sold.id, date: '2024-01-06', items: [{ productId, quantity: 2 }],
  });
  assert.equal(salesReturn.cost, 10000);
  assert.deepEqual(balance(), { q: 7000, v: 35000 });
  assert.equal(movementCount(salesReturn.id), 1);
  assertStockIntegrity();

  const purchaseReturn = invoices.createReturn(db, userId, {
    returnType: 'purchase_return', invoiceId: buy.id, date: '2024-01-07', items: [{ productId, quantity: 3 }],
  });
  assert.equal(purchaseReturn.cost, 15000);
  assert.deepEqual(balance(), { q: 4000, v: 20000 });
  assertStockIntegrity();
});

test('a transfer moves stock between warehouses at the source average, keeping totals and the ledger unchanged', () => {
  purchase(10, 5000);
  const entries = journalCount();
  const result = inventory.transferStock(db, userId, {
    date: '2024-01-03', productId, fromWarehouseId: 'wh_main', toWarehouseId: secondWarehouseId, quantity: 4,
  });
  assert.equal(result.totalCost, 20000);
  assert.deepEqual(balance('wh_main'), { q: 6000, v: 30000 });
  assert.deepEqual(balance(secondWarehouseId), { q: 4000, v: 20000 });
  assert.deepEqual(productTotals(), { q: 10000, v: 50000 });
  assert.equal(journalCount(), entries);
  assert.equal(movementCount(result.id), 2);
  assertStockIntegrity();
});

test('transfers are refused above the available quantity or between the same warehouse', () => {
  purchase(10, 5000);
  assert.throws(() => inventory.transferStock(db, userId, {
    date: '2024-01-03', productId, fromWarehouseId: 'wh_main', toWarehouseId: secondWarehouseId, quantity: 11,
  }), (e) => e instanceof UserFacingError && /غير كافية/.test(e.message));
  assert.throws(() => inventory.transferStock(db, userId, {
    date: '2024-01-03', productId, fromWarehouseId: 'wh_main', toWarehouseId: 'wh_main', quantity: 1,
  }), (e) => e instanceof UserFacingError);
  assert.deepEqual(balance(), { q: 10000, v: 50000 });
});

test('sales draw only from the main warehouse, so stock moved away is not sellable there', () => {
  purchase(10, 5000);
  inventory.transferStock(db, userId, {
    date: '2024-01-03', productId, fromWarehouseId: 'wh_main', toWarehouseId: secondWarehouseId, quantity: 4,
  });
  assert.throws(() => sale(7, 9000), (e) => e instanceof UserFacingError && /غير كافية/.test(e.message));
  assert.deepEqual(balance(), { q: 6000, v: 30000 });
  assertStockIntegrity();
});

test('a count in an empty warehouse needs a unit cost for surplus and posts it to inventory adjustments', () => {
  purchase(10, 5000);
  assert.throws(() => counts.recordStockCount(db, userId, {
    date: '2024-02-01', warehouseId: secondWarehouseId, items: [{ productId, countedQuantity: 3 }],
  }));
  const result = counts.recordStockCount(db, userId, {
    date: '2024-02-01', warehouseId: secondWarehouseId, items: [{ productId, countedQuantity: 3, unitCost: 2000 }],
  });
  assert.equal(result.gains, 6000);
  assert.deepEqual(balance(secondWarehouseId), { q: 3000, v: 6000 });
  assert.deepEqual(balance(), { q: 10000, v: 50000 });
  assertStockIntegrity();
});

test('a surplus in the main warehouse is valued at its average and a shortage at the same average', () => {
  purchase(10, 5000);
  const surplus = counts.recordStockCount(db, userId, {
    date: '2024-02-01', items: [{ productId, countedQuantity: 12 }],
  });
  assert.equal(surplus.gains, 10000);
  assert.deepEqual(balance(), { q: 12000, v: 60000 });
  const shortage = counts.recordStockCount(db, userId, {
    date: '2024-02-02', items: [{ productId, countedQuantity: 9 }],
  });
  assert.equal(shortage.losses, 15000);
  assert.deepEqual(balance(), { q: 9000, v: 45000 });
  assertStockIntegrity();
});

test('a count lists each product once', () => {
  purchase(10, 5000);
  assert.throws(() => counts.recordStockCount(db, userId, {
    date: '2024-02-01', items: [{ productId, countedQuantity: 9 }, { productId, countedQuantity: 8 }],
  }), (e) => e instanceof UserFacingError && /مكرر/.test(e.message));
});

test('a manual receipt is valued from its entered cost and posted to inventory adjustments', () => {
  const result = inventory.recordManualReceipt(db, userId, {
    date: '2024-03-01', productId, warehouseId: 'wh_main', quantity: 2, unitCost: 4000,
  });
  assert.equal(result.totalCost, 8000);
  assert.deepEqual(balance(), { q: 2000, v: 8000 });
  assert.equal(accounting.generalLedger(db, { accountId: 'acc_inventory_adj' }).closing, -8000);
  assertStockIntegrity();
});

test('a manual issue is costed at the average and posted to expenses', () => {
  purchase(10, 5000);
  const result = inventory.recordManualIssue(db, userId, {
    date: '2024-03-02', productId, warehouseId: 'wh_main', quantity: 1,
  });
  assert.equal(result.totalCost, 5000);
  assert.deepEqual(balance(), { q: 9000, v: 45000 });
  assert.equal(accounting.generalLedger(db, { accountId: 'acc_expenses' }).closing, 5000);
  assertStockIntegrity();
});

test('a manual issue above what the warehouse holds is refused and changes nothing', () => {
  purchase(2, 5000);
  assert.throws(() => inventory.recordManualIssue(db, userId, {
    date: '2024-03-02', productId, warehouseId: 'wh_main', quantity: 3,
  }), (e) => e instanceof UserFacingError);
  assert.deepEqual(balance(), { q: 2000, v: 10000 });
});

test('product edits validate input and reorder-level alerts follow the reorder level', () => {
  purchase(3, 5000);
  assert.equal(inventory.listProducts(db).find((p) => p.id === productId).is_low_stock, true);

  inventory.updateProduct(db, userId, { id: productId, name: 'علف مركز', unit: 'كيس', category: 'feed', reorderLevel: 2 });
  const updated = inventory.listProducts(db).find((p) => p.id === productId);
  assert.equal(updated.name, 'علف مركز');
  assert.equal(updated.is_low_stock, false);

  assert.throws(() => inventory.updateProduct(db, userId, { id: productId, name: 'x', unit: 'كيس', category: 'bogus' }),
    (e) => e instanceof UserFacingError);
  assert.throws(() => inventory.updateProduct(db, userId, { id: 'missing', name: 'x', unit: 'كيس' }),
    (e) => e instanceof UserFacingError);
});

test('stock transfer over IPC is permission-checked and refuses over-transfer with a user message', async () => {
  const auth = createAuthService(db);
  await auth.login(OWNER_KEY, { username: 'owner', password: 'owner-pass-1' });
  const handlers = new Map();
  registerFarmHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, auth, () => db, () => tmpDir);
  purchase(10, 5000);

  const ok = await handlers.get('stock:transfer')({ sender: { id: OWNER_KEY } }, {
    date: '2024-01-03', productId, fromWarehouseId: 'wh_main', toWarehouseId: secondWarehouseId, quantity: 4,
  });
  assert.equal(ok.ok, true, ok.error);

  const refused = await handlers.get('stock:transfer')({ sender: { id: OWNER_KEY } }, {
    date: '2024-01-03', productId, fromWarehouseId: 'wh_main', toWarehouseId: secondWarehouseId, quantity: 50,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /غير كافية/);

  const stranger = await handlers.get('stock:transfer')({ sender: { id: 'stranger' } }, {
    date: '2024-01-03', productId, fromWarehouseId: 'wh_main', toWarehouseId: secondWarehouseId, quantity: 1,
  });
  assert.equal(stranger.ok, false);
  assertStockIntegrity();
});
