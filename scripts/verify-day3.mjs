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

const tx = await db.execute(`
  SELECT exchange, COUNT(*) AS n, COUNT(DISTINCT assetSymbol) AS coins
  FROM "Transaction"
  GROUP BY exchange
`);
console.log('Transactions:');
for (const r of tx.rows) console.log(' ', r.exchange, '— n=', r.n, ' coins=', r.coins);

const snap = await db.execute(`
  SELECT exchange, takenAt, totalKrw,
         CASE WHEN rawJson IS NULL THEN 'null'
              ELSE substr(rawJson, 1, 60) END AS rawHead
  FROM BalanceSnapshot
  WHERE id IN (
    SELECT MAX(id) FROM BalanceSnapshot GROUP BY exchange
  )
  ORDER BY exchange
`);
console.log('\nLatest snapshots:');
for (const r of snap.rows) {
  console.log(' ', r.exchange, '@', new Date(Number(r.takenAt)).toISOString(), 'total=', r.totalKrw, ' raw=', r.rawHead);
}

const sample = await db.execute(`
  SELECT exchange, assetSymbol, side, qty, price, fee, externalId, timestamp
  FROM "Transaction"
  ORDER BY timestamp DESC
  LIMIT 5
`);
console.log('\nLatest 5 transactions:');
for (const r of sample.rows) {
  console.log(' ', r.exchange, r.assetSymbol, r.side, 'qty=' + r.qty, 'price=' + r.price, 'fee=' + r.fee, 'ts=' + new Date(Number(r.timestamp)).toISOString().slice(0, 16));
}
