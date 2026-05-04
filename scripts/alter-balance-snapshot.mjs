// BalanceSnapshot.quoteCurrency 추가 (멀티거래소 대응). idempotent.
import fs from 'node:fs';
import { createClient } from '@libsql/client';

const env = fs.readFileSync('.env.local', 'utf8')
  .split('\n').filter(l => /^[A-Z_]+=/.test(l))
  .reduce((acc, l) => {
    const i = l.indexOf('=');
    acc[l.slice(0, i)] = l.slice(i + 1).replace(/^"|"$/g, '');
    return acc;
  }, {});

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const cols = await db.execute(`PRAGMA table_info("BalanceSnapshot")`);
const has = new Set(cols.rows.map(r => r.name));
if (!has.has('quoteCurrency')) {
  await db.execute(`ALTER TABLE "BalanceSnapshot" ADD COLUMN "quoteCurrency" TEXT NOT NULL DEFAULT 'KRW'`);
  console.log('OK:   ADD COLUMN quoteCurrency (default KRW)');
} else {
  console.log('SKIP: quoteCurrency exists');
}
const after = await db.execute(`PRAGMA table_info("BalanceSnapshot")`);
console.log('cols:', after.rows.map(r => `${r.name}:${r.type}`).join(', '));
