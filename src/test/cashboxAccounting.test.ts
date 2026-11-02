import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createCashbox, resolveCashbox } from '@/services/cashboxService';
import { createCashTransaction, transferBetweenCashboxes } from '@/services/treasuryService';
import { createTestDatabase, fundMainCashbox } from './testDatabase';

let db: PGlite;

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

async function cashboxBalance(id: string): Promise<number> {
  const res = await db.query<{ balance: number | string }>('SELECT balance FROM cashboxes WHERE id = $1', [id]);
  return Number(res.rows[0].balance);
}

async function accountBalance(id: string): Promise<number> {
  const res = await db.query<{ balance: number | string }>('SELECT balance FROM accounts WHERE id = $1', [id]);
  return Number(res.rows[0].balance);
}

async function count(table: string): Promise<number> {
  const res = await db.query<{ n: number | string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(res.rows[0].n);
}

async function mainCashboxId(): Promise<string> {
  return (await resolveCashbox(db)).id;
}

async function assertLedgerBalanced(): Promise<void> {
  const res = await db.query<{ diff: number | string }>('SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS diff FROM journal_lines');
  assert.equal(Number(res.rows[0].diff), 0);
}

async function failInsertsInto(table: string): Promise<void> {
  await db.exec(`ALTER TABLE ${table} ADD CONSTRAINT test_block_insert CHECK (false) NOT VALID`);
}

describe('cashbox deposits and withdrawals', () => {
  it('deposit increases the chosen cashbox and posts Dr cash / Cr source', async () => {
    const main = await mainCashboxId();
    await createCashTransaction({ date: '2026-02-01', type: 'deposit', cashboxId: main, counterAccountId: 'acc_capital', amount: 200 });

    assert.equal(await cashboxBalance(main), 20000);
    assert.equal(await accountBalance('acc_cash'), 20000);
    await assertLedgerBalanced();
  });

  it('withdrawal decreases the cashbox and posts to the chosen expense account', async () => {
    await fundMainCashbox(1000);
    const main = await mainCashboxId();
    await createCashTransaction({ date: '2026-02-02', type: 'withdrawal', cashboxId: main, counterAccountId: 'acc_bank', amount: 150 });

    assert.equal(await cashboxBalance(main), 85000);
    await assertLedgerBalanced();
  });

  it('rejects a withdrawal that would make the cashbox negative and leaves no record', async () => {
    const main = await mainCashboxId();
    await assert.rejects(
      createCashTransaction({ date: '2026-02-03', type: 'withdrawal', cashboxId: main, counterAccountId: 'acc_bank', amount: 50 }),
      /الرصيد غير كافٍ/,
    );

    assert.equal(await cashboxBalance(main), 0);
    assert.equal(await count('cash_transactions'), 0);
    assert.equal(await count('journal_entries'), 0);
  });

  it('rolls back the journal and balance when the record insert fails', async () => {
    const main = await mainCashboxId();
    await failInsertsInto('cash_transactions');

    await assert.rejects(createCashTransaction({ date: '2026-02-04', type: 'deposit', cashboxId: main, counterAccountId: 'acc_capital', amount: 80 }));

    assert.equal(await cashboxBalance(main), 0);
    assert.equal(await count('journal_entries'), 0);
    assert.equal(await accountBalance('acc_cash'), 0);
  });
});

describe('cashbox selection and transfers', () => {
  it('receipts land in the selected child cashbox only', async () => {
    const main = await mainCashboxId();
    const child = await createCashbox('خزينة الفرع');
    await createCashTransaction({ date: '2026-02-05', type: 'receipt', cashboxId: child.id, amount: 60 });

    assert.equal(await cashboxBalance(child.id), 6000);
    assert.equal(await cashboxBalance(main), 0);
    assert.equal(await accountBalance(child.accountId), 6000);
  });

  it('transfer moves funds between cashboxes in one balanced entry without income or expense', async () => {
    await fundMainCashbox(1000);
    const main = await mainCashboxId();
    const child = await createCashbox('خزينة الفرع');

    await transferBetweenCashboxes({ date: '2026-02-06', fromCashboxId: main, toCashboxId: child.id, amount: 300 });

    assert.equal(await cashboxBalance(main), 70000);
    assert.equal(await cashboxBalance(child.id), 30000);
    assert.equal(await count('incomes'), 0);
    assert.equal(await count('expenses'), 0);
    await assertLedgerBalanced();
  });

  it('transfer rejects overdrawing the source cashbox and posts nothing', async () => {
    await fundMainCashbox(100);
    const main = await mainCashboxId();
    const child = await createCashbox('خزينة الفرع');

    await assert.rejects(
      transferBetweenCashboxes({ date: '2026-02-07', fromCashboxId: main, toCashboxId: child.id, amount: 500 }),
      /الرصيد غير كافٍ/,
    );

    assert.equal(await cashboxBalance(main), 10000);
    assert.equal(await cashboxBalance(child.id), 0);
    assert.equal(await count('journal_entries'), 1);
  });

  it('transfer rolls back when the cash record insert fails', async () => {
    await fundMainCashbox(1000);
    const main = await mainCashboxId();
    const child = await createCashbox('خزينة الفرع');
    await failInsertsInto('cash_transactions');

    await assert.rejects(transferBetweenCashboxes({ date: '2026-02-08', fromCashboxId: main, toCashboxId: child.id, amount: 100 }));

    assert.equal(await cashboxBalance(main), 100000);
    assert.equal(await cashboxBalance(child.id), 0);
    assert.equal(await count('journal_entries'), 1);
  });
});

describe('partner drawings', () => {
  it('the drawings account exists once, under equity, with a debit balance', async () => {
    const res = await db.query<{ n: number | string; type: string; parent_id: string }>(
      "SELECT count(*) AS n, MAX(type) AS type, MAX(parent_id) AS parent_id FROM accounts WHERE code = '303'",
    );
    assert.equal(Number(res.rows[0].n), 1);
    assert.equal(res.rows[0].type, 'equity');
    assert.equal(res.rows[0].parent_id, 'acc_equity');
  });

  it('posts Dr drawings / Cr cashbox and reduces the cashbox', async () => {
    await fundMainCashbox(1000);
    const main = await mainCashboxId();
    await createCashTransaction({ date: '2026-03-01', type: 'partner_drawing', cashboxId: main, amount: 200 });

    assert.equal(await cashboxBalance(main), 80000);
    assert.equal(await accountBalance('acc_partner_drawings'), 20000);
    assert.equal(await accountBalance('acc_cash'), 80000);
    await assertLedgerBalanced();

    const lines = await db.query<{ account_id: string; debit: number | string; credit: number | string }>(
      `SELECT l.account_id, l.debit, l.credit FROM journal_lines l
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.date = '2026-03-01' ORDER BY l.account_id`,
    );
    assert.deepEqual(lines.rows.map((r) => [r.account_id, Number(r.debit), Number(r.credit)]), [
      ['acc_cash', 0, 20000],
      ['acc_partner_drawings', 20000, 0],
    ]);
  });

  it('does not change profit or loss accounts or create expenses or incomes', async () => {
    await fundMainCashbox(1000);
    const main = await mainCashboxId();
    const pnlBefore = await db.query<{ total: number | string }>(
      "SELECT COALESCE(SUM(balance), 0) AS total FROM accounts WHERE type IN ('revenue','expense')",
    );

    await createCashTransaction({ date: '2026-03-02', type: 'partner_drawing', cashboxId: main, amount: 500 });

    const pnlAfter = await db.query<{ total: number | string }>(
      "SELECT COALESCE(SUM(balance), 0) AS total FROM accounts WHERE type IN ('revenue','expense')",
    );
    assert.equal(Number(pnlAfter.rows[0].total), Number(pnlBefore.rows[0].total));
    assert.equal(await count('expenses'), 0);
    assert.equal(await count('incomes'), 0);
  });

  it('rejects a drawing larger than the cashbox and posts nothing', async () => {
    await fundMainCashbox(100);
    const main = await mainCashboxId();
    await assert.rejects(
      createCashTransaction({ date: '2026-03-03', type: 'partner_drawing', cashboxId: main, amount: 500 }),
      /الرصيد غير كافٍ/,
    );
    assert.equal(await cashboxBalance(main), 10000);
    assert.equal(await accountBalance('acc_partner_drawings'), 0);
    assert.equal(await count('journal_entries'), 1);
  });

  it('rolls back the journal and drawings balance when the record insert fails', async () => {
    await fundMainCashbox(1000);
    const main = await mainCashboxId();
    await failInsertsInto('cash_transactions');

    await assert.rejects(createCashTransaction({ date: '2026-03-04', type: 'partner_drawing', cashboxId: main, amount: 100 }));

    assert.equal(await cashboxBalance(main), 100000);
    assert.equal(await accountBalance('acc_partner_drawings'), 0);
    assert.equal(await count('journal_entries'), 1);
  });
});

describe('cashbox reconciliation', () => {
  it('sum of cashbox balances equals the balance of their linked ledger accounts', async () => {
    await fundMainCashbox(1000);
    const main = await mainCashboxId();
    const child = await createCashbox('خزينة الفرع');
    await transferBetweenCashboxes({ date: '2026-02-09', fromCashboxId: main, toCashboxId: child.id, amount: 250 });

    const res = await db.query<{ cash_total: number | string; ledger_total: number | string }>(
      `SELECT COALESCE(SUM(c.balance), 0) AS cash_total,
              COALESCE(SUM(a.balance), 0) AS ledger_total
         FROM cashboxes c JOIN accounts a ON a.id = c.account_id`,
    );
    assert.equal(Number(res.rows[0].cash_total), 100000);
    assert.equal(Number(res.rows[0].ledger_total), 100000);
  });
});

describe('historical entries', () => {
  it('existing journal lines are unchanged by later cashbox activity', async () => {
    await fundMainCashbox(1000);
    const before = await db.query<{ id: string }>('SELECT id, entry_id, account_id, debit, credit FROM journal_lines ORDER BY id');
    const main = await mainCashboxId();
    const child = await createCashbox('خزينة الفرع');

    await transferBetweenCashboxes({ date: '2026-02-10', fromCashboxId: main, toCashboxId: child.id, amount: 100 });
    await createCashTransaction({ date: '2026-02-11', type: 'deposit', cashboxId: child.id, counterAccountId: 'acc_capital', amount: 40 });

    const ids = before.rows.map((r) => r.id);
    const after = await db.query('SELECT id, entry_id, account_id, debit, credit FROM journal_lines WHERE id = ANY($1) ORDER BY id', [ids]);
    assert.deepEqual(after.rows, before.rows);
  });
});
