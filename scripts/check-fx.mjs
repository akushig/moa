import { createClient } from '@libsql/client';
import 'dotenv/config';
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const r = await db.execute(
  `SELECT * FROM FxRate ORDER BY takenAt DESC LIMIT 5`,
);
console.log('Latest FxRate:');
for (const row of r.rows) console.log(' ', row);
process.exit(0);
