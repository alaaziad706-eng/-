import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { setDbForTesting } from '@/db/db';

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
