import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import {
  createEmployee, createAdvance, generatePayroll, paySalary,
  listSalaryRecords, listAdvances, listDeductions, recordDeduction,
} from '@/services/employeeService';
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

describe('employee deductions', () => {
  it('saves a deduction with its amount, reason and month', async () => {
    const emp = await createEmployee({ name: 'سمير', baseSalary: 3000, salaryType: 'monthly' });
    await recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 150.5, reason: '  تأخير متكرر  ' });

    const rows = await listDeductions('2026-10');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].employee_name, 'سمير');
    assert.equal(rows[0].amount, 15050);
    assert.equal(rows[0].reason, 'تأخير متكرر');
    assert.equal(rows[0].month, '2026-10-01');
    assert.equal(rows[0].applied, false);
    assert.equal(await count('journal_entries'), 0);
  });

  it('reduces net salary and posts the payroll entry on the reduced amount', async () => {
    const emp = await createEmployee({ name: 'خالد', baseSalary: 3000, salaryType: 'monthly' });
    await recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 200, reason: 'غياب' });

    await generatePayroll({ month: '2026-10' });

    const records = await listSalaryRecords('2026-10');
    assert.equal(records[0].deductions, 20000);
    assert.equal(records[0].net_salary, 280000);
    assert.equal(await accountBalance('acc_salaries'), 280000);
    assert.equal(await accountBalance('acc_salaries_pay'), -280000);
    await assertLedgerBalanced();

    const applied = await listDeductions('2026-10');
    assert.equal(applied[0].applied, true);
  });

  it('deducts both penalties and advance installments from net pay', async () => {
    await fundMainCashbox(100000);
    const emp = await createEmployee({ name: 'ياسر', baseSalary: 3000, salaryType: 'monthly' });
    await createAdvance({ employeeId: emp.id, date: '2026-10-01', amount: 1000, repaymentMethod: 'installment', installmentAmount: 400 });
    await recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 200, reason: 'تلف معدات' });

    await generatePayroll({ month: '2026-10' });

    const records = await listSalaryRecords('2026-10');
    assert.equal(records[0].advance_deduct, 40000);
    assert.equal(records[0].net_salary, 240000);
    assert.equal(await accountBalance('acc_salaries'), 280000);
    assert.equal(await accountBalance('acc_advances_emp'), 60000);
    assert.equal((await listAdvances())[0].remaining, 60000);
    await assertLedgerBalanced();
  });

  it('applies a deduction once when payroll is regenerated and only to its own month', async () => {
    const emp = await createEmployee({ name: 'نادر', baseSalary: 3000, salaryType: 'monthly' });
    await recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 100, reason: 'غياب' });

    await generatePayroll({ month: '2026-10' });
    await generatePayroll({ month: '2026-10' });
    await generatePayroll({ month: '2026-11' });

    const oct = await listSalaryRecords('2026-10');
    const nov = await listSalaryRecords('2026-11');
    assert.equal(oct.length, 1);
    assert.equal(oct[0].net_salary, 290000);
    assert.equal(nov[0].deductions, 0);
    assert.equal(nov[0].net_salary, 300000);
    assert.equal(await count('journal_entries'), 2);
    await assertLedgerBalanced();
  });

  it('refuses a deduction for a month whose payroll already exists', async () => {
    const emp = await createEmployee({ name: 'طارق', baseSalary: 3000, salaryType: 'monthly' });
    await generatePayroll({ month: '2026-10' });

    await assert.rejects(
      recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 100, reason: 'متأخر' }),
      /تم إنشاء مسير/
    );
    assert.equal(await count('employee_deductions'), 0);
  });

  it('rejects deductions above the base salary and empty reasons', async () => {
    const emp = await createEmployee({ name: 'حسن', baseSalary: 1000, salaryType: 'monthly' });
    await recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 600, reason: 'جزاء' });

    await assert.rejects(
      recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 500, reason: 'جزاء ثان' }),
      /يتجاوز الراتب الأساسي/
    );
    await assert.rejects(
      recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 50, reason: '   ' }),
      /سبب الخصم مطلوب/
    );
    assert.equal(await count('employee_deductions'), 1);
  });

  it('pays the reduced net salary and clears the payable', async () => {
    await fundMainCashbox(100000);
    const emp = await createEmployee({ name: 'عمر', baseSalary: 3000, salaryType: 'monthly' });
    await recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 200, reason: 'غياب' });
    await generatePayroll({ month: '2026-10' });

    const [record] = await listSalaryRecords('2026-10');
    await paySalary(record.id);

    assert.equal(await accountBalance('acc_salaries_pay'), 0);
    assert.equal(await accountBalance('acc_cash'), 10000000 - 280000);
    assert.equal(await accountBalance('acc_salaries'), 280000);
    const [paid] = await listSalaryRecords('2026-10');
    assert.equal(paid.status, 'paid');
    assert.equal(paid.net_salary, 280000);
    await assertLedgerBalanced();
  });
});
