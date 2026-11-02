const { handleSafely } = require('./handleSafely');
const expenses = require('../services/expenseService');
const parties = require('../services/partyService');
const accounting = require('../services/accountingService');
const payroll = require('../services/payrollService');
const treasury = require('../services/treasuryService');
const backups = require('../services/backupService');
const invoices = require('../services/invoiceService');
const customerCredits = require('../services/customerCreditService');
const inventory = require('../services/inventoryService');
const stockCounts = require('../services/stockCountService');
const { dashboardSummary } = require('../services/dashboardService');

// كل قناة تستدعي دالة خدمة واحدة بعد التحقق من صلاحية محددة. المعرّف يأتي من الجلسة فقط
function farmChannels() {
  return [
    ['expenses:categories', 'expenses.view', (db) => ({
      expense: expenses.listExpenseCategories(db),
      income: expenses.listIncomeCategories(db),
    })],
    ['expenses:list', 'expenses.view', (db, _uid, args) => expenses.listExpenses(db, args)],
    ['expenses:create', 'expenses.add', (db, uid, input) => expenses.createExpense(db, uid, input)],
    ['incomes:list', 'expenses.view', (db, _uid, args) => expenses.listIncomes(db, args)],
    ['incomes:create', 'expenses.add', (db, uid, input) => expenses.createIncome(db, uid, input)],
    ['expenses:cancel', 'expenses.edit', (db, uid, input) => expenses.cancelExpense(db, uid, input)],
    ['incomes:cancel', 'expenses.edit', (db, uid, input) => expenses.cancelIncome(db, uid, input)],

    ['treasury:cashboxes', 'treasury.view', (db) => treasury.listCashboxes(db)],
    ['treasury:createCashbox', 'treasury.add', (db, uid, input) => treasury.createCashbox(db, uid, input)],
    ['treasury:statement', 'treasury.view', (db, _uid, args) => treasury.cashStatement(db, args)],
    ['transfers:list', 'transfers.view', (db) => treasury.listTransfers(db)],
    ['transfers:create', 'transfers.add', (db, uid, input) => treasury.createTransfer(db, uid, input)],
    ['checks:list', 'checks.view', (db) => treasury.listChecks(db)],
    ['checks:create', 'checks.add', (db, uid, input) => treasury.createCheck(db, uid, input)],
    ['activities:list', 'parties.view', (db) => accounting.listActivities(db)],
    ['parties:list', 'parties.view', (db, _uid, args) => parties.listParties(db, args)],
    ['parties:create', 'parties.add', (db, uid, input) => parties.createPartyWithOpening(db, uid, input)],
    ['parties:statement', 'parties.view', (db, _uid, args) => parties.partyStatement(db, args)],
    ['parties:delete', 'parties.delete', (db, uid, input) => parties.deleteParty(db, uid, input?.partyId)],

    ['employees:list', 'employees.view', (db) => payroll.listEmployees(db)],
    ['employees:create', 'employees.add', (db, uid, input) => payroll.createEmployee(db, uid, input)],
    ['employees:attendance', 'employees.view', (db, _uid, args) => payroll.listAttendance(db, args)],
    ['employees:recordAttendance', 'employees.edit', (db, uid, input) => payroll.recordAttendance(db, uid, input)],
    ['employees:advances', 'employees.view', (db, _uid, args) => payroll.listAdvances(db, args)],
    ['employees:createAdvance', 'employees.add', (db, uid, input) => payroll.createAdvance(db, uid, input)],
    ['employees:salaries', 'employees.view', (db, _uid, args) => payroll.listSalaries(db, args)],
    ['employees:createSalary', 'employees.add', (db, uid, input) => payroll.createSalary(db, uid, input)],
    ['employees:paySalary', 'employees.edit', (db, uid, input) => payroll.paySalary(db, uid, input)],

    ['products:list', 'inventory.view', (db) => inventory.listProducts(db)],
    ['products:create', 'inventory.add', (db, uid, input) => inventory.createProduct(db, uid, input)],
    ['products:update', 'inventory.edit', (db, uid, input) => inventory.updateProduct(db, uid, input)],
    ['warehouses:list', 'inventory.view', (db) => inventory.listWarehouses(db)],
    ['warehouses:create', 'inventory.add', (db, uid, input) => inventory.createWarehouse(db, uid, input)],
    ['stock:balances', 'inventory.view', (db, _uid, args) => inventory.listStockBalances(db, args?.warehouseId)],
    ['stock:movements', 'inventory.view', (db, _uid, args) => inventory.listStockMovements(db, {
      productId: args?.productId ?? null, warehouseId: args?.warehouseId ?? null,
    })],
    ['stock:receive', 'inventory.add', (db, uid, input) => inventory.recordManualReceipt(db, uid, input)],
    ['stock:issue', 'inventory.add', (db, uid, input) => inventory.recordManualIssue(db, uid, input)],
    ['stock:transfer', 'inventory.add', (db, uid, input) => inventory.transferStock(db, uid, input)],
    ['stock:counts', 'inventory.view', (db) => stockCounts.listStockCounts(db)],
    ['stock:count', 'inventory.edit', (db, uid, input) => stockCounts.recordStockCount(db, uid, input)],
    ['invoices:list', 'sales.view', (db, _uid, args) => invoices.listInvoices(db, args?.docType)],
    ['invoices:create', 'sales.add', (db, uid, input) => invoices.createInvoice(db, uid, input)],
    ['invoices:pay', 'sales.add', (db, uid, input) => invoices.recordPayment(db, uid, input)],
    ['invoices:return', 'sales.add', (db, uid, input) => invoices.createReturn(db, uid, input)],
    ['invoices:cancel', 'sales.edit', (db, uid, input) => invoices.cancelInvoice(db, uid, input)],
    ['customers:credits', 'sales.view', (db) => customerCredits.listCustomerCredits(db)],
    ['customers:refundCredit', 'treasury.add', (db, uid, input) => customerCredits.refundCustomerCredit(db, uid, input)],

    ['dashboard:summary', 'dashboard.view', (db, _uid, args) => dashboardSummary(db, args)],
  ];
}

function registerFarmHandlers(ipcMain, auth, getDatabase, getBackupDir) {
  for (const [channel, permission, run] of farmChannels()) {
    handleSafely(ipcMain, channel, (key, payload) => {
      const actor = auth.requirePermission(key, permission);
      return run(getDatabase(), actor.id, payload);
    });
  }
  handleSafely(ipcMain, 'backup:list', (key) => {
    auth.requirePermission(key, 'backup.view');
    return backups.listBackups(getBackupDir());
  });
}

module.exports = { registerFarmHandlers };
