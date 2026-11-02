import { getDb, type SqlRunner } from '@/db/db';

export interface BackupLog {
  id: string;
  filename: string;
  file_size: number | null;
  status: string;
  is_manual: boolean;
  notes: string | null;
  created_at: string;
}

/**
 * في بيئة المتصفح: تصدير قاعدة البيانات كـ JSON (نسخة احتياطية حقيقية).
 * في بيئة Electron الإنتاجية: تُستبدل هذه الدوال بآلية SQLite Backup API.
 */

// ترتيب الجداول يتبع الاعتماد بينها (الجدول الأب قبل الأبناء)
const DATA_TABLES = [
  'users', 'roles', 'permissions', 'user_permissions', 'audit_logs', 'app_settings',
  'activities', 'fiscal_periods', 'document_sequences', 'accounts', 'journal_entries',
  'journal_lines', 'opening_balances', 'parties', 'party_transactions', 'cashboxes',
  'cash_transactions', 'financial_transfers', 'checks', 'invoices', 'invoice_items',
  'payments', 'returns', 'products', 'stock_movements', 'stock_counts', 'stock_count_items',
  'expense_categories', 'expenses', 'expense_distributions', 'income_categories', 'incomes',
  'employees', 'attendance', 'salary_records', 'employee_advances', 'employee_deductions',
  'custom_fields', 'import_batches',
];

// سجل النسخ الاحتياطية يُصدَّر ولا يُستعاد، حتى لا تُمحى سجلات العمليات الحالية
const LOG_TABLES = ['backup_logs'];

export async function listBackupLogs(): Promise<BackupLog[]> {
  const db = await getDb();
  const res = await db.query<BackupLog>(
    `SELECT id, filename, file_size, status, is_manual, notes, created_at::text FROM backup_logs ORDER BY created_at DESC`
  );
  return res.rows;
}

export async function createBackup(manual: boolean, createdBy: string | null): Promise<BackupLog> {
  const db = await getDb();
  const filename = `farm-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const data = await exportDatabaseData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const fileSize = blob.size;

  // تنزيل الملف فعليًا
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);

  const res = await db.query<BackupLog>(
    `INSERT INTO backup_logs (filename, file_size, status, is_manual, created_by)
     VALUES ($1, $2, 'success', $3, $4)
     RETURNING id, filename, file_size, status, is_manual, notes, created_at::text`,
    [filename, fileSize, manual, createdBy]
  );
  return res.rows[0];
}

export async function restoreBackup(file: File): Promise<{ success: boolean; message: string }> {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data._meta || data._meta.type !== 'farm-backup') {
      return { success: false, message: 'الملف ليس نسخة احتياطية صالحة' };
    }
    await importDatabaseData(data);
    const db = await getDb();
    await db.query(
      `INSERT INTO backup_logs (filename, file_size, status, is_manual, notes) VALUES ($1, $2, 'restored', true, 'استعادة من ملف')`,
      [file.name, file.size]
    );
    return { success: true, message: 'تمت الاستعادة بنجاح. يُنصح بإعادة تشغيل البرنامج.' };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : 'خطأ في الاستعادة' };
  }
}

export async function exportDatabaseData(): Promise<Record<string, unknown>> {
  const db = await getDb();
  const data: Record<string, unknown> = { _meta: { type: 'farm-backup', version: 1, date: new Date().toISOString() } };
  for (const table of [...DATA_TABLES, ...LOG_TABLES]) {
    const present = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [table]);
    if (!present.rows[0].present) continue;
    const res = await db.query<{ row: Record<string, unknown> }>(`SELECT row_to_json(t) as row FROM ${table} t`);
    data[table] = res.rows.map((r) => r.row);
  }
  return data;
}

/**
 * يستعيد الجداول الموجودة في النسخة داخل معاملة واحدة: أي خطأ يلغي الاستعادة كلها.
 * الجداول الغائبة عن النسخة القديمة لا تُمس، بل تُحفظ صفوفها وتُعاد بعد الاستعادة
 * حتى لا يحذفها الحذف المتتالي للجدول الأب (مثل خصومات الموظفين عند حذف الموظفين).
 */
async function importDatabaseData(data: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  const tables = DATA_TABLES.filter((table) => Array.isArray(data[table]));

  await db.transaction(async (tx) => {
    const kept = new Map<string, Record<string, unknown>[]>();
    for (const child of await findChildTablesOutside(tx, tables)) {
      const res = await tx.query<{ row: Record<string, unknown> }>(`SELECT row_to_json(t) as row FROM ${child} t`);
      kept.set(child, res.rows.map((r) => r.row));
    }

    for (const table of [...tables].reverse()) {
      await tx.query(`DELETE FROM ${table}`);
    }
    for (const table of tables) {
      await insertRows(tx, table, data[table] as Record<string, unknown>[]);
    }
    for (const [child, rows] of kept) {
      await tx.query(`DELETE FROM ${child}`);
      await insertRows(tx, child, rows);
    }
  });
}

async function findChildTablesOutside(tx: SqlRunner, tables: string[]): Promise<string[]> {
  if (tables.length === 0) return [];
  const inList = tables.map((t) => `'${t}'`).join(', ');
  const res = await tx.query<{ child: string }>(
    `SELECT DISTINCT conrelid::regclass::text AS child FROM pg_constraint
     WHERE contype = 'f' AND confrelid::regclass::text IN (${inList})`
  );
  return res.rows
    .map((r) => r.child)
    .filter((child) => !tables.includes(child) && !LOG_TABLES.includes(child));
}

async function insertRows(tx: SqlRunner, table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.query(
    `INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1::json)`,
    [JSON.stringify(rows)]
  );
}
