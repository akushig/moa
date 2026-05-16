import { createClient } from '@libsql/client';
import 'dotenv/config';
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const r = await db.execute(
  `SELECT id, takenAt, json_extract(rawJson, '$.loanDebts') AS debts,
          json_extract(rawJson, '$.walletWarnings') AS warnings
   FROM BalanceSnapshot WHERE exchange='binance' ORDER BY takenAt DESC LIMIT 6`,
);
console.log('Latest 6 binance snapshots — loanDebts/warnings:');
for (const row of r.rows) {
  console.log(`#${row.id} ${row.takenAt}`);
  console.log('  debts:', row.debts);
  console.log('  warnings:', row.warnings);
}
process.exit(0);
