import { getDb, toCents, toEgp, type SqlRunner } from '@/db/db';
import { createJournalEntry } from './accountingService';
import { moveCashbox, resolveCashbox } from './cashboxService';

export interface Employee {
  id: string;
  name: string;
  phone: string | null;
  job_title: string | null;
  hire_date: string | null;
  base_salary: number;
  salary_type: string;
  status: string;
  activity_id: string | null;
}

export async function listEmployees(): Promise<Employee[]> {
  const db = await getDb();
  const res = await db.query<Employee>(
    `SELECT id, name, phone, job_title, hire_date::text, base_salary, salary_type, status, activity_id FROM employees ORDER BY name`
  );
  return res.rows;
}

export async function createEmployee(data: {
  name: string; phone?: string; jobTitle?: string; hireDate?: string;
  baseSalary: number; salaryType: string; activityId?: string | null;
}): Promise<Employee> {
  const db = await getDb();
  const res = await db.query<Employee>(
    `INSERT INTO employees (name, phone, job_title, hire_date, base_salary, salary_type, activity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, phone, job_title, hire_date::text, base_salary, salary_type, status, activity_id`,
    [data.name, data.phone ?? null, data.jobTitle ?? null, data.hireDate ?? null,
     toCents(data.baseSalary), data.salaryType, data.activityId ?? null]
  );
  return res.rows[0];
}

export async function updateEmployee(id: string, data: Partial<{
  name: string; phone: string; job_title: string; hire_date: string;
  base_salary: number; salary_type: string; status: string; activity_id: string;
}>): Promise<void> {
  const db = await getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (data.name !== undefined) { values.push(data.name); fields.push(`name = $${values.length}`); }
  if (data.phone !== undefined) { values.push(data.phone); fields.push(`phone = $${values.length}`); }
  if (data.job_title !== undefined) { values.push(data.job_title); fields.push(`job_title = $${values.length}`); }
  if (data.hire_date !== undefined) { values.push(data.hire_date); fields.push(`hire_date = $${values.length}`); }
  if (data.base_salary !== undefined) { values.push(toCents(data.base_salary)); fields.push(`base_salary = $${values.length}`); }
  if (data.salary_type !== undefined) { values.push(data.salary_type); fields.push(`salary_type = $${values.length}`); }
  if (data.status !== undefined) { values.push(data.status); fields.push(`status = $${values.length}`); }
  if (data.activity_id !== undefined) { values.push(data.activity_id); fields.push(`activity_id = $${values.length}`); }
  if (fields.length === 0) return;
  values.push(id);
  await db.query(`UPDATE employees SET ${fields.join(', ')}, updated_at = now() WHERE id = $${values.length}`, values);
}

export async function deleteEmployee(id: string): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM employees WHERE id = $1', [id]);
}

export interface Attendance {
  id: string;
  employee_id: string;
  employee_name: string;
  date: string;
  status: string;
  check_in: string | null;
  check_out: string | null;
  notes: string | null;
}

export async function listAttendance(employeeId?: string, month?: string): Promise<Attendance[]> {
  const db = await getDb();
  let query = `
    SELECT a.id, a.employee_id, e.name as employee_name, a.date::text, a.status,
           a.check_in::text, a.check_out::text, a.notes
    FROM attendance a JOIN employees e ON a.employee_id = e.id WHERE 1=1`;
  const params: unknown[] = [];
  if (employeeId) { params.push(employeeId); query += ` AND a.employee_id = $${params.length}`; }
  if (month) { params.push(month); query += ` AND a.date::text LIKE $${params.length}`; }
  query += ' ORDER BY a.date DESC';
  const res = await db.query<Attendance>(query, params);
  return res.rows;
}

export async function recordAttendance(data: {
  employeeId: string; date: string; status: string; checkIn?: string; checkOut?: string; notes?: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO attendance (employee_id, date, status, check_in, check_out, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [data.employeeId, data.date, data.status, data.checkIn ?? null, data.checkOut ?? null, data.notes ?? null]
  );
}

export interface SalaryRecord {
  id: string;
  employee_id: string;
  employee_name: string;
  month: string;
  base_salary: number;
  overtime: number;
  deductions: number;
  advance_deduct: number;
  net_salary: number;
  status: string;
}

export async function listSalaryRecords(month?: string): Promise<SalaryRecord[]> {
  const db = await getDb();
  let query = `
    SELECT s.id, s.employee_id, e.name as employee_name, s.month::text, s.base_salary,
           s.overtime, s.deductions, s.advance_deduct, s.net_salary, s.status
    FROM salary_records s JOIN employees e ON s.employee_id = e.id`;
  const params: unknown[] = [];
  if (month) { params.push(`${month}%`); query += ` WHERE s.month::text LIKE $${params.length}`; }
  query += ' ORDER BY s.month DESC, e.name';
  const res = await db.query<SalaryRecord>(query, params);
  return res.rows;
}

async function accrueSalary(
  data: { employeeId: string; month: string; baseSalary: number; createdBy?: string | null },
  runner: SqlRunner
): Promise<void> {
  const pendingDeductions = await runner.query<{ amount: number | string }>(
    'SELECT amount FROM employee_deductions WHERE employee_id = $1 AND month = $2 AND salary_record_id IS NULL FOR UPDATE',
    [data.employeeId, `${data.month}-01`]
  );
  const deductions = pendingDeductions.rows.reduce((sum, d) => sum + Number(d.amount), 0);
  if (deductions > data.baseSalary) throw new Error('إجمالي خصومات الموظف يتجاوز راتبه الأساسي');

  const advances = await runner.query<{ id: string; installment_amount: number; remaining: number }>(
    "SELECT id, installment_amount, remaining FROM employee_advances WHERE employee_id = $1 AND status = 'active' AND remaining > 0 ORDER BY date, id FOR UPDATE",
    [data.employeeId]
  );

  const grossAfterDeductions = data.baseSalary - deductions;
  let advanceRecovery = 0;
  for (const adv of advances.rows) {
    const due = adv.installment_amount > 0 ? Math.min(adv.installment_amount, adv.remaining) : adv.remaining;
    const take = Math.min(due, grossAfterDeductions - advanceRecovery);
    if (take <= 0) continue;
    advanceRecovery += take;
    await runner.query(
      "UPDATE employee_advances SET total_paid = total_paid + $1, remaining = remaining - $1, status = CASE WHEN remaining - $1 <= 0 THEN 'settled' ELSE 'active' END WHERE id = $2",
      [take, adv.id]
    );
  }

  const net = grossAfterDeductions - advanceRecovery;
  let journalEntryId: string | null = null;
  if (grossAfterDeductions > 0) {
    const journal = await createJournalEntry({
      date: `${data.month}-01`,
      description: `استحقاق راتب ${data.month}`,
      referenceType: 'salary',
      lines: [
        { accountId: 'acc_salaries', debit: toEgp(grossAfterDeductions), credit: 0 },
        ...(advanceRecovery > 0 ? [{ accountId: 'acc_advances_emp', debit: 0, credit: toEgp(advanceRecovery) }] : []),
        { accountId: 'acc_salaries_pay', debit: 0, credit: toEgp(net) },
      ],
      createdBy: data.createdBy,
    }, runner);
    journalEntryId = journal.id;
  }

  const inserted = await runner.query<{ id: string }>(
    `INSERT INTO salary_records (employee_id, month, base_salary, overtime, deductions, advance_deduct, net_salary, status, journal_entry_id)
     VALUES ($1, $2, $3, 0, $4, $5, $6, 'pending', $7)
     RETURNING id`,
    [data.employeeId, `${data.month}-01`, data.baseSalary, deductions, advanceRecovery, net, journalEntryId]
  );
  if (pendingDeductions.rows.length > 0) {
    await runner.query(
      'UPDATE employee_deductions SET salary_record_id = $1 WHERE employee_id = $2 AND month = $3 AND salary_record_id IS NULL',
      [inserted.rows[0].id, data.employeeId, `${data.month}-01`]
    );
  }
}

export async function generatePayroll(data: { month: string; createdBy?: string | null }): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const employees = await tx.query<{ id: string; base_salary: number }>(
      'SELECT id, base_salary FROM employees WHERE status = $1', ['active']
    );
    for (const emp of employees.rows) {
      const exists = await tx.query<{ count: number }>(
        'SELECT count(*) as count FROM salary_records WHERE employee_id = $1 AND month::text LIKE $2',
        [emp.id, data.month + '%']
      );
      if (exists.rows[0].count > 0) continue;
      await accrueSalary({ employeeId: emp.id, month: data.month, baseSalary: emp.base_salary, createdBy: data.createdBy }, tx);
    }
  });
}

export async function paySalary(id: string, createdBy?: string | null, cashboxId?: string): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    const record = await tx.query<{ net_salary: number; status: string }>(
      'SELECT net_salary, status FROM salary_records WHERE id = $1 FOR UPDATE', [id]
    );
    if (record.rows.length === 0) throw new Error('السجل غير موجود');
    const r = record.rows[0];
    if (r.status !== 'pending') throw new Error('الراتب مدفوع بالفعل');
    const box = await resolveCashbox(tx, cashboxId);

    await createJournalEntry({
      date: new Date().toISOString().slice(0, 10),
      description: `صرف راتب ${toEgp(r.net_salary)} ج.م`,
      referenceType: 'salary',
      lines: [
        { accountId: 'acc_salaries_pay', debit: toEgp(r.net_salary), credit: 0 },
        { accountId: box.accountId, debit: 0, credit: toEgp(r.net_salary) },
      ],
      createdBy,
    }, tx);

    await moveCashbox(tx, box.id, -Number(r.net_salary), true);
    await tx.query("UPDATE salary_records SET status = 'paid', paid_at = now() WHERE id = $1", [id]);
  });
}

export interface EmployeeDeduction {
  id: string;
  employee_id: string;
  employee_name: string;
  month: string;
  amount: number;
  reason: string;
  applied: boolean;
}

export async function listDeductions(month?: string): Promise<EmployeeDeduction[]> {
  const db = await getDb();
  let query = `
    SELECT d.id, d.employee_id, e.name AS employee_name, d.month::text, d.amount, d.reason,
           d.salary_record_id IS NOT NULL AS applied
    FROM employee_deductions d JOIN employees e ON d.employee_id = e.id`;
  const params: unknown[] = [];
  if (month) { params.push(`${month}%`); query += ' WHERE d.month::text LIKE $1'; }
  query += ' ORDER BY d.month DESC, e.name';
  const res = await db.query<EmployeeDeduction>(query, params);
  return res.rows;
}

export async function recordDeduction(data: {
  employeeId: string; month: string; amount: number; reason: string;
}): Promise<void> {
  const reason = data.reason.trim();
  if (!reason) throw new Error('سبب الخصم مطلوب');
  if (!(data.amount > 0)) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
  if (!/^\d{4}-\d{2}$/.test(data.month)) throw new Error('الشهر غير صحيح');

  const db = await getDb();
  await db.transaction(async (tx) => {
    const employee = await tx.query<{ base_salary: number | string }>(
      'SELECT base_salary FROM employees WHERE id = $1', [data.employeeId]
    );
    if (employee.rows.length === 0) throw new Error('الموظف غير موجود');

    const payroll = await tx.query<{ count: number | string }>(
      'SELECT count(*) AS count FROM salary_records WHERE employee_id = $1 AND month::text LIKE $2',
      [data.employeeId, `${data.month}%`]
    );
    if (Number(payroll.rows[0].count) > 0) throw new Error('تم إنشاء مسير هذا الشهر لهذا الموظف، لا يمكن إضافة خصم له');

    const pending = await tx.query<{ total: number | string }>(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM employee_deductions WHERE employee_id = $1 AND month = $2 AND salary_record_id IS NULL',
      [data.employeeId, `${data.month}-01`]
    );
    const total = Number(pending.rows[0].total) + toCents(data.amount);
    if (total > Number(employee.rows[0].base_salary)) throw new Error('إجمالي خصومات الشهر يتجاوز الراتب الأساسي للموظف');

    await tx.query(
      'INSERT INTO employee_deductions (employee_id, month, amount, reason) VALUES ($1, $2, $3, $4)',
      [data.employeeId, `${data.month}-01`, toCents(data.amount), reason]
    );
  });
}

export interface EmployeeAdvance {
  id: string;
  employee_id: string;
  employee_name: string;
  date: string;
  amount: number;
  repayment_method: string;
  installment_amount: number;
  total_paid: number;
  remaining: number;
  status: string;
}

export async function listAdvances(): Promise<EmployeeAdvance[]> {
  const db = await getDb();
  const res = await db.query<EmployeeAdvance>(
    `SELECT a.id, a.employee_id, e.name as employee_name, a.date::text, a.amount,
            a.repayment_method, a.installment_amount, a.total_paid, a.remaining, a.status
     FROM employee_advances a JOIN employees e ON a.employee_id = e.id ORDER BY a.date DESC`
  );
  return res.rows;
}

export async function createAdvance(data: {
  employeeId: string; date: string; amount: number; repaymentMethod?: string; installmentAmount?: number; cashboxId?: string; createdBy?: string | null;
}): Promise<void> {
  if (data.amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
  const db = await getDb();
  await db.transaction(async (tx) => {
    const box = await resolveCashbox(tx, data.cashboxId);
    const journal = await createJournalEntry({
      date: data.date,
      description: `سلفة موظف`,
      referenceType: 'advance',
      lines: [
        { accountId: 'acc_advances_emp', debit: data.amount, credit: 0 },
        { accountId: box.accountId, debit: 0, credit: data.amount },
      ],
      createdBy: data.createdBy,
    }, tx);

    await moveCashbox(tx, box.id, -toCents(data.amount), true);
    await tx.query(
      `INSERT INTO employee_advances (employee_id, date, amount, repayment_method, installment_amount, total_paid, remaining, status, journal_entry_id)
       VALUES ($1, $2, $3, $4, $5, 0, $3, 'active', $6)`,
      [data.employeeId, data.date, toCents(data.amount), data.repaymentMethod ?? 'installment', toCents(data.installmentAmount ?? 0), journal.id]
    );
  });
}
