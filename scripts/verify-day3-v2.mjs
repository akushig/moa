import fs from 'node:fs';
import { createClient } from '@libsql/client';
const env = fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).reduce((acc, l) => { const i = l.indexOf('='); acc[l.slice(0,i)] = l.slice(i+1).replace(/^"|"$/g,''); return acc; }, {});
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const r = await db.execute(`SELECT exchange, side, COUNT(*) AS n FROM "Transaction" WHERE source='exchange' GROUP BY exchange, side ORDER BY exchange, side`);
console.log('Transactions by exchange × side:');
for (const row of r.rows) console.log(' ', row.exchange.padEnd(8), row.side.padEnd(10), 'n=' + row.n);

const total = await db.execute(`SELECT COUNT(*) AS n FROM "Transaction" WHERE source='exchange'`);
console.log('total:', total.rows[0].n);

const ps = await db.execute(`SELECT COUNT(*) AS n, MIN(takenAt) AS first, MAX(takenAt) AS last FROM "PriceSnapshot"`);
const psRow = ps.rows[0];
console.log('\nPriceSnapshot:', psRow.n, 'rows', psRow.n > 0 ? `(${new Date(Number(psRow.first)).toISOString().slice(0,16)} ~ ${new Date(Number(psRow.last)).toISOString().slice(0,16)})` : '');

const fx = await db.execute(`SELECT COUNT(*) AS n FROM "FxRate"`);
console.log('FxRate:', fx.rows[0].n, 'rows');
