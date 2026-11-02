import { getDb, type SqlRunner } from '@/db/db';

export const DEFAULT_CASHBOX_NAME = 'الخزينة الرئيسية';
const MAIN_CASH_ACCOUNT_ID = 'acc_cash';
const FIRST_CHILD_CODE = 1010;

export interface CashboxRef {
  id: string;
  accountId: string;
}

export async function ensureDefaultCashbox(runner?: SqlRunner): Promise<void> {
  const db = runner ?? (await getDb());
  const res = await db.query<{ count: number }>('SELECT count(*) as count FROM cashboxes');
  if (res.rows[0].count === 0) {
    await db.query(
      'INSERT INTO cashboxes (name, account_id, opening_balance, balance) VALUES ($1, $2, 0, 0)',
      [DEFAULT_CASHBOX_NAME, MAIN_CASH_ACCOUNT_ID]
    );
  }
}

export async function resolveCashbox(runner: SqlRunner, cashboxId?: string): Promise<CashboxRef> {
  if (!cashboxId) {
    await ensureDefaultCashbox(runner);
    const res = await runner.query<{ id: string; account_id: string | null }>(
      'SELECT id, account_id FROM cashboxes WHERE account_id = $1 ORDER BY created_at, id LIMIT 1',
      [MAIN_CASH_ACCOUNT_ID]
    );
    if (res.rows.length === 0 || !res.rows[0].account_id) throw new Error('الخزينة الرئيسية غير مرتبطة بحساب');
    return { id: res.rows[0].id, accountId: res.rows[0].account_id };
  }

  const res = await runner.query<{ id: string; account_id: string | null; is_active: boolean }>(
    'SELECT id, account_id, is_active FROM cashboxes WHERE id = $1',
    [cashboxId]
  );
  if (res.rows.length === 0) throw new Error('الخزينة غير موجودة');
  const row = res.rows[0];
  if (!row.is_active) throw new Error('الخزينة غير نشطة');
  if (!row.account_id) throw new Error('الخزينة غير مرتبطة بحساب');
  return { id: row.id, accountId: row.account_id };
}

export async function createCashbox(name: string): Promise<CashboxRef> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('اسم الخزينة مطلوب');
  const db = await getDb();

  return db.transaction(async (tx) => {
    const codeRes = await tx.query<{ max_code: number | null }>(
      "SELECT MAX(CAST(code AS INTEGER)) AS max_code FROM accounts WHERE parent_id = $1 AND code ~ '^[0-9]+$'",
      [MAIN_CASH_ACCOUNT_ID]
    );
    const code = String((codeRes.rows[0].max_code ?? FIRST_CHILD_CODE - 1) + 1);

    const accountRes = await tx.query<{ id: string }>(
      "INSERT INTO accounts (code, name, type, parent_id) VALUES ($1, $2, 'asset', $3) RETURNING id",
      [code, `خزينة - ${trimmed}`, MAIN_CASH_ACCOUNT_ID]
    );
    const accountId = accountRes.rows[0].id;

    const cashboxRes = await tx.query<{ id: string }>(
      'INSERT INTO cashboxes (name, account_id, opening_balance, balance) VALUES ($1, $2, 0, 0) RETURNING id',
      [trimmed, accountId]
    );
    return { id: cashboxRes.rows[0].id, accountId };
  });
}

export async function moveCashbox(runner: SqlRunner, cashboxId: string, deltaCents: number, requireFunds: boolean): Promise<void> {
  if (requireFunds) {
    const res = await runner.query<{ balance: number | string }>(
      'SELECT balance FROM cashboxes WHERE id = $1 FOR UPDATE',
      [cashboxId]
    );
    if (res.rows.length === 0) throw new Error('الخزينة غير موجودة');
    if (Number(res.rows[0].balance) + deltaCents < 0) throw new Error('الرصيد غير كافٍ في الخزينة');
  }
  await runner.query('UPDATE cashboxes SET balance = balance + $1, updated_at = now() WHERE id = $2', [deltaCents, cashboxId]);
}
