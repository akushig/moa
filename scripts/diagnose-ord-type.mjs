import fs from 'node:fs';
import { createClient } from '@libsql/client';
import { Decimal } from 'decimal.js';

const env = fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).reduce((acc, l) => { const i = l.indexOf('='); acc[l.slice(0,i)] = l.slice(i+1).replace(/^"|"$/g,''); return acc; }, {});
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

const r = await db.execute(`
  SELECT exchange, side, note AS ord_type, COUNT(*) AS n, MIN(price) AS minP, MAX(price) AS maxP
  FROM "Transaction"
  WHERE source='exchange'
  GROUP BY exchange, side, note
  ORDER BY exchange, side, note
`);
console.log('=== ord_type distribution ===');
for (const row of r.rows) {
  console.log(' ', row.exchange.padEnd(8), row.side.padEnd(5), (row.ord_type ?? 'null').padEnd(10), 'n=' + String(row.n).padStart(4), ' price range:', row.minP, '~', row.maxP);
}

// 의심 row 직접
console.log('\n=== suspicious low-price rows (price < 1M) ===');
const sus = await db.execute(`
  SELECT exchange, assetSymbol, side, note, qty, price, fee, timestamp
  FROM "Transaction"
  WHERE source='exchange' AND CAST(price AS REAL) < 1000000
  ORDER BY exchange, assetSymbol, timestamp
`);
for (const t of sus.rows) {
  const date = new Date(Number(t.timestamp)).toISOString().slice(0,10);
  console.log(`  ${t.exchange.padEnd(8)} ${t.assetSymbol.padEnd(6)} ${date} ${t.side} ord_type=${t.note} qty=${t.qty} price=${t.price}`);
}
