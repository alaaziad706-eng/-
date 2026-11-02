import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { exportDatabaseData, restoreBackup } from '@/services/backupService';
import { createEmployee, generatePayroll, listDeductions, listSalaryRecords, recordDeduction } from '@/services/employeeService';
import { createTestDatabase } from './testDatabase';

let db: PGlite;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

type Row = Record<string, unknown>;

function backupFile(data: Record<string, unknown>): File {
  return new File([JSON.stringify(data)], 'backup.json', { type: 'application/json' });
}

function rowsOf(data: Record<string, unknown>, table: string): Row[] {
  return data[table] as Row[];
}

function withoutMeta(data: Record<string, unknown>): Record<string, unknown> {
  const { _meta: _ignored, ...rest } = data;
  void _ignored;
  return rest;
}

async function seedPayrollWithDeduction(): Promise<{ employeeId: string; deductionId: string; salaryRecordId: string }> {
  const emp = await createEmployee({ name: 'سمير', baseSalary: 3000, salaryType: 'monthly' });
  await recordDeduction({ employeeId: emp.id, month: '2026-10', amount: 200, reason: 'غياب' });
  await generatePayroll({ month: '2026-10' });
  const [deduction] = await listDeductions('2026-10');
  const [record] = await listSalaryRecords('2026-10');
  return { employeeId: emp.id, deductionId: deduction.id, salaryRecordId: record.id };
}

describe('backup export', () => {
  it('saves employee deductions with their employee, month, amount and reason', async () => {
    const { employeeId, deductionId } = await seedPayrollWithDeduction();

    const data = await exportDatabaseData();
    const rows = rowsOf(data, 'employee_deductions');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, deductionId);
    assert.equal(rows[0].employee_id, employeeId);
    assert.equal(rows[0].month, '2026-10-01');
    assert.equal(Number(rows[0].amount), 20000);
    assert.equal(rows[0].reason, 'غياب');
    assert.ok(rows[0].salary_record_id);
  });
});

describe('backup restore', () => {
  it('restores deductions with their employee, month and payroll links', async () => {
    const { employeeId, deductionId, salaryRecordId } = await seedPayrollWithDeduction();
    const backup = await exportDatabaseData();

    const other = await createEmployee({ name: 'مريم', baseSalary: 2000, salaryType: 'monthly' });
    await recordDeduction({ employeeId: other.id, month: '2026-11', amount: 50, reason: 'تأخير' });
    assert.equal((await listDeductions()).length, 2);

    const result = await restoreBackup(backupFile(backup));
    assert.equal(result.success, true);

    const res = await db.query<{ id: string; employee_id: string; employee_name: string; month: string; amount: number | string; reason: string; salary_record_id: string | null }>(
      `SELECT d.id, d.employee_id, e.name AS employee_name, d.month::text, d.amount, d.reason, d.salary_record_id
       FROM employee_deductions d JOIN employees e ON e.id = d.employee_id`
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].id, deductionId);
    assert.equal(res.rows[0].employee_id, employeeId);
    assert.equal(res.rows[0].employee_name, 'سمير');
    assert.equal(res.rows[0].month, '2026-10-01');
    assert.equal(Number(res.rows[0].amount), 20000);
    assert.equal(res.rows[0].reason, 'غياب');
    assert.equal(res.rows[0].salary_record_id, salaryRecordId);

    const [record] = await listSalaryRecords('2026-10');
    assert.equal(record.deductions, 20000);
    assert.equal(record.net_salary, 280000);
  });

  it('keeps existing deductions when restoring a backup made before the deductions table existed', async () => {
    const { deductionId, salaryRecordId } = await seedPayrollWithDeduction();
    const oldBackup = await exportDatabaseData();
    delete oldBackup.employee_deductions;

    const result = await restoreBackup(backupFile(oldBackup));
    assert.equal(result.success, true);

    const res = await db.query<{ id: string; salary_record_id: string | null }>(
      'SELECT id, salary_record_id FROM employee_deductions'
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].id, deductionId);
    assert.equal(res.rows[0].salary_record_id, salaryRecordId);
    assert.equal((await listSalaryRecords('2026-10')).length, 1);
  });

  it('leaves the database unchanged when a restore fails midway', async () => {
    await seedPayrollWithDeduction();
    const before = withoutMeta(await exportDatabaseData());

    const broken = await exportDatabaseData();
    rowsOf(broken, 'employee_deductions')[0].amount = 0;
    const result = await restoreBackup(backupFile(broken));
    assert.equal(result.success, false);

    const after = withoutMeta(await exportDatabaseData());
    assert.deepEqual(after, before);
    assert.equal((await listDeductions('2026-10')).length, 1);
  });
});
