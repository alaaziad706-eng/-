import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createJournalEntry, reverseJournalEntry } from '@/services/accountingService';
import { recordPayment } from '@/services/invoiceService';
import { createParty } from '@/services/partyService';
import { createExpense, createIncome } from '@/services/expensesService';
import { createCheck, createTransfer } from '@/services/financeService';
import { createCashTransaction } from '@/services/treasuryService';
import { createTestDatabase } from './testDatabase';

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

// يفرض فشل أي إدراج لاحق في الجدول بعد ترحيل القيد، فيختبر التراجع الكامل
async function failInsertsInto(table: string): Promise<void> {
  await db.exec(`ALTER TABLE ${table} ADD CONSTRAINT test_block_insert CHECK (false) NOT VALID`);
}

async function seedCashbox(id: string): Promise<void> {
  await db.query('INSERT INTO cashboxes (id, name) VALUES ($1, $2)', [id, 'الخزينة الرئيسية']);
}

async function cashboxBalance(id: string): Promise<number> {
  const res = await db.query<{ balance: number | string }>('SELECT balance FROM cashboxes WHERE id = $1', [id]);
  return Number(res.rows[0].balance);
}

async function assertNothingPosted(): Promise<void> {
  assert.equal(await count('journal_entries'), 0);
  assert.equal(await count('journal_lines'), 0);
  assert.equal(await accountBalance('acc_cash'), 0);
}

describe('recordPayment atomicity', () => {
  it('posts journal, payment and party movement together', async () => {
    const party = await createParty({ name: 'عميل', type: 'customer' });

    await recordPayment({ partyId: party.id, date: '2026-10-05', amount: 50, paymentMethod: 'cash', direction: 'inbound' });

    assert.equal(await count('payments'), 1);
    assert.equal(await count('journal_entries'), 1);
    assert.equal(await count('party_transactions'), 1);
    assert.equal(await accountBalance('acc_cash'), 5000);
    await assertLedgerBalanced();
  });

  it('rolls back journal and party movement when the payment insert fails', async () => {
    const party = await createParty({ name: 'عميل', type: 'customer' });
    const partyMovementsBefore = await count('party_transactions');
    await failInsertsInto('payments');

    await assert.rejects(recordPayment({ partyId: party.id, date: '2026-10-05', amount: 50, paymentMethod: 'cash', direction: 'inbound' }));

    assert.equal(await count('payments'), 0);
    assert.equal(await count('party_transactions'), partyMovementsBefore);
    assert.equal(await count('journal_entries'), 0);
    assert.equal(await accountBalance('acc_cash'), 0);
    await assertLedgerBalanced();
  });
});

describe('expense and income atomicity', () => {
  it('posts expense journal and record together', async () => {
    await createExpense({ date: '2026-10-05', categoryId: 'ec_admin', amount: 30, paymentMethod: 'cash' });

    assert.equal(await count('expenses'), 1);
    assert.equal(await count('journal_entries'), 1);
    assert.equal(await accountBalance('acc_admin'), 3000);
    assert.equal(await accountBalance('acc_cash'), -3000);
    await assertLedgerBalanced();
  });

  it('rolls back expense journal when the expense insert fails', async () => {
    await failInsertsInto('expenses');

    await assert.rejects(createExpense({ date: '2026-10-05', categoryId: 'ec_admin', amount: 30, paymentMethod: 'cash' }));

    assert.equal(await count('expenses'), 0);
    await assertNothingPosted();
  });

  it('rolls back income journal when the income insert fails', async () => {
    await failInsertsInto('incomes');

    await assert.rejects(createIncome({ date: '2026-10-05', categoryId: 'ic_other', amount: 20, paymentMethod: 'cash' }));

    assert.equal(await count('incomes'), 0);
    await assertNothingPosted();
  });
});

describe('check and transfer atomicity', () => {
  it('posts check journal and record together', async () => {
    await createCheck({ date: '2026-10-05', direction: 'outgoing', amount: 15, dueDate: '2026-11-30' });

    assert.equal(await count('checks'), 1);
    assert.equal(await count('journal_entries'), 1);
    await assertLedgerBalanced();
  });

  it('rolls back check journal when the check insert fails', async () => {
    await failInsertsInto('checks');

    await assert.rejects(createCheck({ date: '2026-10-05', direction: 'outgoing', amount: 15, dueDate: '2026-11-30' }));

    assert.equal(await count('checks'), 0);
    assert.equal(await count('journal_entries'), 0);
  });

  it('rolls back transfer journal when the transfer insert fails', async () => {
    await failInsertsInto('financial_transfers');

    await assert.rejects(createTransfer({ date: '2026-10-05', direction: 'outbound', amount: 10 }));

    assert.equal(await count('financial_transfers'), 0);
    assert.equal(await count('journal_entries'), 0);
  });
});

describe('cash transaction atomicity', () => {
  it('posts journal, cashbox balance and record together', async () => {
    await seedCashbox('cb1');

    await createCashTransaction({ date: '2026-10-05', type: 'receipt', cashboxId: 'cb1', amount: 40 });

    assert.equal(await count('cash_transactions'), 1);
    assert.equal(await cashboxBalance('cb1'), 4000);
    assert.equal(await accountBalance('acc_cash'), 4000);
    await assertLedgerBalanced();
  });

  it('rolls back journal and cashbox balance when the record insert fails', async () => {
    await seedCashbox('cb1');
    await failInsertsInto('cash_transactions');

    await assert.rejects(createCashTransaction({ date: '2026-10-05', type: 'receipt', cashboxId: 'cb1', amount: 40 }));

    assert.equal(await count('cash_transactions'), 0);
    assert.equal(await cashboxBalance('cb1'), 0);
    await assertNothingPosted();
  });
});

describe('reverseJournalEntry', () => {
  async function postOriginalEntry(): Promise<string> {
    const entry = await createJournalEntry({
      date: '2026-10-05',
      description: 'قيد أصلي',
      referenceType: 'manual',
      lines: [
        { accountId: 'acc_cash', debit: 100, credit: 0 },
        { accountId: 'acc_sales', debit: 0, credit: 100 },
      ],
    });
    return entry.id;
  }

  it('posts a counter entry, keeps the original lines and marks it reversed', async () => {
    const originalId = await postOriginalEntry();

    await reverseJournalEntry(originalId, '2026-10-06');

    const status = await db.query<{ status: string }>('SELECT status FROM journal_entries WHERE id = $1', [originalId]);
    assert.equal(status.rows[0].status, 'reversed');
    assert.equal(await count('journal_entries'), 2);
    assert.equal(await count('journal_lines'), 4);
    assert.equal(await accountBalance('acc_cash'), 0);
    assert.equal(await accountBalance('acc_sales'), 0);
    await assertLedgerBalanced();
  });

  it('refuses a second reversal and creates no extra counter entry', async () => {
    const originalId = await postOriginalEntry();
    await reverseJournalEntry(originalId, '2026-10-06');

    await assert.rejects(reverseJournalEntry(originalId, '2026-10-06'), /ملغى بالفعل/);

    const reversals = await db.query<{ n: number | string }>(
      "SELECT count(*) AS n FROM journal_entries WHERE reference_type = 'reversal'"
    );
    assert.equal(Number(reversals.rows[0].n), 1);
    await assertLedgerBalanced();
  });

  it('rolls back the counter entry when marking the original reversed fails', async () => {
    const originalId = await postOriginalEntry();
    await db.exec("ALTER TABLE journal_entries ADD CONSTRAINT test_block_reversed CHECK (status <> 'reversed') NOT VALID");

    await assert.rejects(reverseJournalEntry(originalId, '2026-10-06'));

    assert.equal(await count('journal_entries'), 1);
    assert.equal(await count('journal_lines'), 2);
    assert.equal(await accountBalance('acc_cash'), 10000);
    const status = await db.query<{ status: string }>('SELECT status FROM journal_entries WHERE id = $1', [originalId]);
    assert.equal(status.rows[0].status, 'posted');
  });

  it('database rejects a second reversal row for the same entry', async () => {
    const originalId = await postOriginalEntry();
    await reverseJournalEntry(originalId, '2026-10-06');

    await assert.rejects(
      createJournalEntry({
        date: '2026-10-06',
        description: 'تكرار',
        referenceType: 'reversal',
        referenceId: originalId,
        lines: [
          { accountId: 'acc_cash', debit: 0, credit: 100 },
          { accountId: 'acc_sales', debit: 100, credit: 0 },
        ],
      })
    );

    assert.equal(await count('journal_entries'), 2);
    assert.equal(await accountBalance('acc_cash'), 0);
  });
});
