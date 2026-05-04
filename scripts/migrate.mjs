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
const sql = fs.readFileSync('/tmp/moa-init.sql', 'utf8');
const stmts = sql
  .split(';')
  .map(s =>
    s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim(),
  )
  .filter(s => s.length > 0);

for (const s of stmts) {
  const head = s.split('\n')[0].slice(0, 70);
  try {
    await db.execute(s);
    console.log('OK:  ', head);
  } catch (e) {
    console.log('SKIP:', head, '→', e.message);
  }
}

const r = await db.execute(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`);
console.log('\ntables:', r.rows.map(x => x.name).join(', '));
