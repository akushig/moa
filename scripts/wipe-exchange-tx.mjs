// 잘못 저장된 source='exchange' transaction 삭제. (executed_funds 사용 안 한 시점 데이터)
// idempotent re-ingest 가능하므로 안전하게 wipe + 재 ingest 가능.
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

const before = await db.execute(`SELECT COUNT(*) AS n FROM "Transaction" WHERE source='exchange'`);
console.log('before delete:', before.rows[0].n);
const r = await db.execute(`DELETE FROM "Transaction" WHERE source='exchange'`);
console.log('deleted:', r.rowsAffected);
const after = await db.execute(`SELECT COUNT(*) AS n FROM "Transaction"`);
console.log('total Transaction rows after:', after.rows[0].n);
