import fs from 'node:fs';
import { createClient } from '@libsql/client';

// Day 3: Transaction.externalId 추가 + unique index. migrate.mjs 가
// CREATE TABLE 만 다루므로 column 추가는 별도. idempotent.
const env = fs.readFileSync('.env.local', 'utf8')
  .split('\n').filter(l => /^[A-Z_]+=/.test(l))
  .reduce((acc, l) => {
    const i = l.indexOf('=');
    acc[l.slice(0, i)] = l.slice(i + 1).replace(/^"|"$/g, '');
    return acc;
  }, {});

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const cols = await db.execute(`PRAGMA table_info("Transaction")`);
const has = new Set(cols.rows.map(r => r.name));
if (!has.has('externalId')) {
  await db.execute(`ALTER TABLE "Transaction" ADD COLUMN "externalId" TEXT`);
  console.log('OK:   ADD COLUMN externalId');
} else {
  console.log('SKIP: externalId exists');
}

try {
  await db.execute(
    `CREATE UNIQUE INDEX "Transaction_source_exchange_externalId_key"
     ON "Transaction"("source", "exchange", "externalId")`,
  );
  console.log('OK:   CREATE UNIQUE INDEX');
} catch (e) {
  console.log('SKIP: index →', e.message);
}

const idx = await db.execute(`PRAGMA index_list("Transaction")`);
console.log('indexes:', idx.rows.map(r => r.name).join(', '));
