import { createClient } from '@libsql/client';
import 'dotenv/config';
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const r1 = await db.execute(
  `SELECT side, COUNT(*) AS n FROM "Transaction" WHERE source='exchange' AND exchange='binance' GROUP BY side`,
);
console.log('Binance tx by side:');
for (const row of r1.rows) console.log(' ', row);
const r2 = await db.execute(
  `SELECT assetSymbol, COUNT(*) AS n, MIN(timestamp) AS oldest, MAX(timestamp) AS newest
        FROM "Transaction" WHERE source='exchange' AND exchange='binance'
        GROUP BY assetSymbol ORDER BY n DESC LIMIT 20`,
);
console.log('\nTop 20 symbols:');
for (const row of r2.rows) console.log(' ', row);

const r3 = await db.execute(
  `SELECT exchange, quoteCurrency, totalKrw, takenAt
        FROM BalanceSnapshot ORDER BY takenAt DESC LIMIT 6`,
);
console.log('\nLatest 6 snapshots:');
for (const row of r3.rows) console.log(' ', row);

process.exit(0);
