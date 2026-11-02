import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createJournalEntry } from '@/services/accountingService';
import { createInvoice } from '@/services/invoiceService';
import { createParty } from '@/services/partyService';
import { createEmployee, createAdvance, generatePayroll, paySalary, listSalaryRecords, listAdvances } from '@/services/employeeService';
import { createTestDatabase, fundMainCashbox } from './testDatabase';

let db: PGlite;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

async function accountBalance(id: string): Promise<number> {
  const res = await db.query<{ balance: number | string }>('SELECT balance FROM accounts WHERE id = $1', [id]);
  return Number(res.rows[0].balance);
}

async function count(table: string): Promise<number> {
  const res = await db.query<{ n: number | string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(res.rows[0].n);
}

async function assertLedgerBalanced(): Promise<void> {
  const res = await db.query<{ diff: number | string }>('SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS diff FROM journal_lines');
  assert.equal(Number(res.rows[0].diff), 0);
}

async function seedProduct(id: string, quantity: number, avgCostCents: number): Promise<void> {
  await db.query(
    'INSERT INTO products (id, name, unit, quantity, avg_cost) VALUES ($1, $2, $3, $4, $5)',
    [id, `صنف ${id}`, 'كجم', quantity, avgCostCents]
  );
}

async function productRow(id: string): Promise<{ quantity: number; avg_cost: number }> {
  const res = await db.query<{ quantity: number | string; avg_cost: number | string }>(
    'SELECT quantity, avg_cost FROM products WHERE id = $1', [id]
  );
  return { quantity: Number(res.rows[0].quantity), avg_cost: Number(res.rows[0].avg_cost) };
}

describe('createJournalEntry', () => {
  it('rolls back the whole entry when a line fails', async () => {
    const seqBefore = await db.query<{ next_number: number }>("SELECT next_number FROM document_sequences WHERE doc_type = 'journal'");
    await assert.rejects(createJournalEntry({
      date: '2026-10-01',
      lines: [
        { accountId: 'acc_cash', debit: 100, credit: 0 },
        { accountId: 'acc_missing', debit: 0, credit: 100 },
      ],
    }));
    assert.equal(await count('journal_entries'), 0);
    assert.equal(await count('journal_lines'), 0);
    assert.equal(await accountBalance('acc_cash'), 0);
    const seqAfter = await db.query<{ next_number: number }>("SELECT next_number FROM document_sequences WHERE doc_type = 'journal'");
    assert.equal(seqAfter.rows[0].next_number, seqBefore.rows[0].next_number);
  });

  it('rejects an unbalanced entry without writing anything', async () => {
    await assert.rejects(createJournalEntry({
      date: '2026-10-01',
      lines: [
        { accountId: 'acc_cash', debit: 100, credit: 0 },
        { accountId: 'acc_sales', debit: 0, credit: 90 },
      ],
    }), /غير متوازن/);
    assert.equal(await count('journal_entries'), 0);
  });
});

describe('sales and purchases', () => {
  it('sale reduces stock and posts COGS at average cost', async () => {
    await seedProduct('p1', 10, 500);
    const party = await createParty({ name: 'عميل', type: 'customer' });

    await createInvoice({
      date: '2026-10-05',
      docType: 'sales',
      partyId: party.id,
      paymentMethod: 'cash',
      items: [{ productId: 'p1', description: 'بيع', quantity: 4, unit: 'كجم', unitPrice: 10, discount: 0 }],
      discount: 0,
    });

    assert.equal((await productRow('p1')).quantity, 6);
    assert.equal(await accountBalance('acc_cogs'), 2000);
    assert.equal(await accountBalance('acc_inventory'), -2000);
    assert.equal(await accountBalance('acc_sales'), -4000);
    assert.equal(await accountBalance('acc_cash'), 4000);
    await assertLedgerBalanced();

    const mv = await db.query<{ type: string; direction: string; quantity: number | string; unit_cost: number | string; balance_after: number | string; journal_entry_id: string | null }>(
      'SELECT type, direction, quantity, unit_cost, balance_after, journal_entry_id FROM stock_movements'
    );
    assert.equal(mv.rows.length, 1);
    assert.equal(mv.rows[0].type, 'sale');
    assert.equal(mv.rows[0].direction, 'out');
    assert.equal(Number(mv.rows[0].unit_cost), 500);
    assert.equal(Number(mv.rows[0].balance_after), 6);
    assert.ok(mv.rows[0].journal_entry_id);
  });

  it('purchase updates weighted average cost and debits inventory', async () => {
    await fundMainCashbox(100000);
    await seedProduct('p2', 0, 0);
    const party = await createParty({ name: 'مورد', type: 'supplier' });

    await createInvoice({
      date: '2026-10-05',
      docType: 'purchase',
      partyId: party.id,
      paymentMethod: 'cash',
      items: [{ productId: 'p2', description: 'شراء', quantity: 10, unit: 'كجم', unitPrice: 5, discount: 0 }],
      discount: 0,
    });
    assert.deepEqual(await productRow('p2'), { quantity: 10, avg_cost: 500 });

    await createInvoice({
      date: '2026-10-06',
      docType: 'purchase',
      partyId: party.id,
      paymentMethod: 'cash',
      items: [{ productId: 'p2', description: 'شراء', quantity: 10, unit: 'كجم', unitPrice: 7, discount: 0 }],
      discount: 0,
    });
    assert.deepEqual(await productRow('p2'), { quantity: 20, avg_cost: 600 });
    assert.equal(await accountBalance('acc_inventory'), 12000);
    assert.equal(await accountBalance('acc_cash'), 10000000 - 12000);
    await assertLedgerBalanced();
  });

  it('rejects an oversold sale and leaves no partial data', async () => {
    await seedProduct('p3', 1, 500);
    const party = await createParty({ name: 'عميل', type: 'customer' });

    await assert.rejects(createInvoice({
      date: '2026-10-05',
      docType: 'sales',
      partyId: party.id,
      paymentMethod: 'cash',
      items: [{ productId: 'p3', description: 'بيع', quantity: 5, unit: 'كجم', unitPrice: 10, discount: 0 }],
      discount: 0,
    }), /المتاحة/);

    assert.equal((await productRow('p3')).quantity, 1);
    assert.equal(await count('invoices'), 0);
    assert.equal(await count('invoice_items'), 0);
    assert.equal(await count('stock_movements'), 0);
    assert.equal(await count('journal_entries'), 0);
  });
});

describe('payroll', () => {
  it('accrues salary once per month, does not duplicate on regenerate, and pay clears the payable', async () => {
    await fundMainCashbox(100000);
    const emp = await createEmployee({ name: 'أحمد', baseSalary: 3000, salaryType: 'monthly' });

    await generatePayroll({ month: '2026-10' });
    await generatePayroll({ month: '2026-10' });

    const records = await listSalaryRecords('2026-10');
    assert.equal(records.length, 1);
    assert.equal(records[0].net_salary, 300000);
    assert.equal(await accountBalance('acc_salaries'), 300000);
    assert.equal(await accountBalance('acc_salaries_pay'), -300000);
    await assertLedgerBalanced();

    await paySalary(records[0].id);
    assert.equal(await accountBalance('acc_salaries_pay'), 0);
    assert.equal(await accountBalance('acc_cash'), 10000000 - 300000);
    assert.equal(await accountBalance('acc_salaries'), 300000);
    await assertLedgerBalanced();

    const paid = await listSalaryRecords('2026-10');
    assert.equal(paid[0].status, 'paid');
    await assert.rejects(paySalary(records[0].id), /مدفوع بالفعل/);
    assert.ok(emp.id);
  });

  it('recovers advance installments from salary and settles the advance', async () => {
    await fundMainCashbox(100000);
    const emp = await createEmployee({ name: 'محمد', baseSalary: 3000, salaryType: 'monthly' });
    await createAdvance({ employeeId: emp.id, date: '2026-10-01', amount: 1000, repaymentMethod: 'installment', installmentAmount: 400 });

    await generatePayroll({ month: '2026-10' });
    let advances = await listAdvances();
    assert.equal(advances[0].remaining, 60000);
    assert.equal(advances[0].status, 'active');

    await generatePayroll({ month: '2026-11' });
    await generatePayroll({ month: '2026-12' });
    advances = await listAdvances();
    assert.equal(advances[0].remaining, 0);
    assert.equal(advances[0].status, 'settled');

    const records = await listSalaryRecords();
    const recovered = records.reduce((s, r) => s + r.advance_deduct, 0);
    assert.equal(recovered, 100000);
    assert.equal(await accountBalance('acc_advances_emp'), 0);
    await assertLedgerBalanced();
  });

  it('caps advance recovery at the salary so net pay is never negative', async () => {
    await fundMainCashbox(100000);
    const emp = await createEmployee({ name: 'علي', baseSalary: 500, salaryType: 'monthly' });
    await createAdvance({ employeeId: emp.id, date: '2026-10-01', amount: 2000, repaymentMethod: 'lump_sum', installmentAmount: 0 });

    await generatePayroll({ month: '2026-10' });
    const records = await listSalaryRecords('2026-10');
    assert.equal(records[0].advance_deduct, 50000);
    assert.equal(records[0].net_salary, 0);
    assert.equal(await count('journal_entries'), 3);
    await assertLedgerBalanced();
  });
});
