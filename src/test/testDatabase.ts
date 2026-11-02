import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { setDbForTesting } from '@/db/db';
import { createCashTransaction } from '@/services/treasuryService';

export async function fundMainCashbox(amount: number): Promise<void> {
  await createCashTransaction({ date: '2026-01-01', type: 'opening', amount, description: 'رصيد افتتاحي للاختبار' });
}

export async function createTestDatabase(): Promise<PGlite> {
  Object.assign(globalThis, { window: globalThis, location: { pathname: '/' } });
  const db = new PGlite();
  const dir = resolve('src/db/migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    await db.exec(readFileSync(resolve(dir, file), 'utf8'));
  }
  setDbForTesting(db);
  return db;
}
