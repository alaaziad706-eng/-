import { getDb, toCents, type SqlRunner } from '@/db/db';
import { createJournalEntry, nextDocNumber } from './accountingService';
import { ensureDefaultCashbox, moveCashbox, resolveCashbox } from './cashboxService';

export interface Cashbox {
  id: string;
  name: string;
  opening_balance: number;
  balance: number;
  is_active: boolean;
}

export interface CashTransaction {
  id: string;
  doc_number: string;
  date: string;
  type: string;
  cashbox_id: string;
  amount: number;
  party_id: string | null;
  party_name: string | null;
  activity_id: string | null;
  payment_method: string;
  description: string | null;
}

export type CashMovementType = 'receipt' | 'payment' | 'deposit' | 'withdrawal' | 'opening';

export const DEPOSIT_SOURCE_ACCOUNTS = ['acc_bank', 'acc_capital', 'acc_other_income'];
const WITHDRAWAL_BANK_ACCOUNT = 'acc_bank';

export async function listCashboxes(): Promise<Cashbox[]> {
  await ensureDefaultCashbox();
  const db = await getDb();
  const res = await db.query<Cashbox>('SELECT id, name, opening_balance, balance, is_active FROM cashboxes ORDER BY name');
  return res.rows;
}

export async function listCashTransactions(limit = 100, filters?: { type?: string; dateFrom?: string; dateTo?: string }): Promise<CashTransaction[]> {
  const db = await getDb();
  let query = `
    SELECT c.id, c.doc_number, c.date::text, c.type, c.cashbox_id, c.amount, c.party_id,
           p.name as party_name, c.activity_id, c.payment_method, c.description
    FROM cash_transactions c LEFT JOIN parties p ON c.party_id = p.id WHERE 1=1`;
  const params: unknown[] = [];
  if (filters?.type) { params.push(filters.type); query += ` AND c.type = $${params.length}`; }
  if (filters?.dateFrom) { params.push(filters.dateFrom); query += ` AND c.date >= $${params.length}`; }
  if (filters?.dateTo) { params.push(filters.dateTo); query += ` AND c.date <= $${params.length}`; }
  params.push(limit);
  query += ` ORDER BY c.date DESC, c.doc_number DESC LIMIT $${params.length}`;

  const res = await db.query<CashTransaction>(query, params);
  return res.rows;
}

async function assertWithdrawalAccount(runner: SqlRunner, accountId: string): Promise<void> {
  if (accountId === WITHDRAWAL_BANK_ACCOUNT) return;
  const res = await runner.query<{ type: string; is_active: boolean }>(
    'SELECT type, is_active FROM accounts WHERE id = $1',
    [accountId]
  );
  const row = res.rows[0];
  if (!row || !row.is_active || row.type !== 'expense') throw new Error('حساب السحب غير صالح');
}

function assertDepositSource(accountId: string): void {
  if (!DEPOSIT_SOURCE_ACCOUNTS.includes(accountId)) throw new Error('مصدر الإيداع غير صالح');
}

export async function createCashTransaction(data: {
  date: string;
  type: CashMovementType;
  cashboxId?: string;
  counterAccountId?: string;
  amount: number;
  partyId?: string | null;
  activityId?: string | null;
  paymentMethod?: string;
  description?: string;
  createdBy?: string | null;
}): Promise<{ id: string; docNumber: string }> {
  if (data.amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
  const db = await getDb();
  const amountCents = toCents(data.amount);
  const isInflow = data.type === 'receipt' || data.type === 'deposit' || data.type === 'opening';

  return db.transaction(async (tx) => {
    const box = await resolveCashbox(tx, data.cashboxId);

    let counterAccount: string;
    if (data.type === 'receipt') counterAccount = 'acc_ar';
    else if (data.type === 'payment') counterAccount = 'acc_ap';
    else if (data.type === 'opening') counterAccount = 'acc_capital';
    else {
      if (!data.counterAccountId) throw new Error('اختر الحساب المقابل');
      if (data.type === 'deposit') assertDepositSource(data.counterAccountId);
      else await assertWithdrawalAccount(tx, data.counterAccountId);
      counterAccount = data.counterAccountId;
    }

    const docNumber = await nextDocNumber(isInflow ? 'receipt' : 'payment', tx);
    const lines = isInflow
      ? [{ accountId: box.accountId, debit: data.amount, credit: 0 }, { accountId: counterAccount, debit: 0, credit: data.amount }]
      : [{ accountId: counterAccount, debit: data.amount, credit: 0 }, { accountId: box.accountId, debit: 0, credit: data.amount }];

    const journal = await createJournalEntry({
      date: data.date,
      description: data.description ?? `سند ${isInflow ? 'قبض' : 'صرف'} ${docNumber}`,
      referenceType: 'cash',
      activityId: data.activityId,
      lines,
      createdBy: data.createdBy,
    }, tx);

    const res = await tx.query<{ id: string }>(
      `INSERT INTO cash_transactions (doc_number, date, type, cashbox_id, amount, party_id, activity_id, account_id, payment_method, description, journal_entry_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [docNumber, data.date, data.type, box.id, amountCents, data.partyId ?? null, data.activityId ?? null, counterAccount,
       data.paymentMethod ?? 'cash', data.description ?? null, journal.id, data.createdBy ?? null]
    );

    await moveCashbox(tx, box.id, isInflow ? amountCents : -amountCents, !isInflow);

    return { id: res.rows[0].id, docNumber };
  });
}

export async function transferBetweenCashboxes(data: {
  date: string;
  fromCashboxId: string;
  toCashboxId: string;
  amount: number;
  description?: string;
  createdBy?: string | null;
}): Promise<{ docNumber: string }> {
  if (data.amount <= 0) throw new Error('المبلغ يجب أن يكون أكبر من صفر');
  if (data.fromCashboxId === data.toCashboxId) throw new Error('لا يمكن التحويل إلى نفس الخزينة');
  const db = await getDb();
  const amountCents = toCents(data.amount);

  return db.transaction(async (tx) => {
    const from = await resolveCashbox(tx, data.fromCashboxId);
    const to = await resolveCashbox(tx, data.toCashboxId);
    const docNumber = await nextDocNumber('transfer', tx);
    const inDocNumber = await nextDocNumber('transfer', tx);

    const journal = await createJournalEntry({
      date: data.date,
      description: data.description ?? `تحويل بين الخزائن ${docNumber}`,
      referenceType: 'cash_transfer',
      lines: [
        { accountId: to.accountId, debit: data.amount, credit: 0 },
        { accountId: from.accountId, debit: 0, credit: data.amount },
      ],
      createdBy: data.createdBy,
    }, tx);

    await tx.query(
      `INSERT INTO cash_transactions (doc_number, date, type, cashbox_id, amount, account_id, payment_method, description, journal_entry_id, created_by)
       VALUES ($1, $2, 'transfer_out', $3, $4, $5, 'cash', $6, $7, $8)`,
      [docNumber, data.date, from.id, amountCents, to.accountId, data.description ?? null, journal.id, data.createdBy ?? null]
    );
    await tx.query(
      `INSERT INTO cash_transactions (doc_number, date, type, cashbox_id, amount, account_id, payment_method, description, journal_entry_id, created_by)
       VALUES ($1, $2, 'transfer_in', $3, $4, $5, 'cash', $6, $7, $8)`,
      [inDocNumber, data.date, to.id, amountCents, from.accountId, data.description ?? null, journal.id, data.createdBy ?? null]
    );

    await moveCashbox(tx, from.id, -amountCents, true);
    await moveCashbox(tx, to.id, amountCents, false);

    return { docNumber };
  });
}
