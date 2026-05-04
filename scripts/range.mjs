import fs from 'node:fs';
import { createClient } from '@libsql/client';
const env = fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).reduce((acc, l) => { const i = l.indexOf('='); acc[l.slice(0,i)] = l.slice(i+1).replace(/^"|"$/g,''); return acc; }, {});
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const r = await db.execute(`SELECT exchange, MIN(timestamp) AS first, MAX(timestamp) AS last, COUNT(*) AS n FROM "Transaction" GROUP BY exchange`);
for (const row of r.rows) {
  console.log(row.exchange, 'first=' + new Date(Number(row.first)).toISOString().slice(0,10), 'last=' + new Date(Number(row.last)).toISOString().slice(0,10), 'n=' + row.n);
}
const r2 = await db.execute(`SELECT exchange, assetSymbol, COUNT(*) AS n, MIN(timestamp) AS first FROM "Transaction" GROUP BY exchange, assetSymbol ORDER BY exchange, n DESC`);
console.log('\nper-coin:');
for (const row of r2.rows) {
  console.log(' ', row.exchange, row.assetSymbol, 'n=' + row.n, 'oldest=' + new Date(Number(row.first)).toISOString().slice(0,10));
}
