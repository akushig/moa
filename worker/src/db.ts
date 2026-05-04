import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error('TURSO_DATABASE_URL not set');

export const db = createClient({ url, authToken });

export type SnapshotInput = {
  exchange: 'upbit' | 'bithumb';
  totalKrw: string;
  cashKrw: string;
  cryptoKrw: string;
  unpriced: { currency: string; balance: string }[];
  raw?: unknown;
};

// Prisma 가 SQLite/libSQL DateTime 을 INTEGER (epoch ms) 로 매핑한다.
export async function insertSnapshot(s: SnapshotInput): Promise<void> {
  await db.execute({
    sql: `INSERT INTO BalanceSnapshot
            (takenAt, exchange, totalKrw, cashKrw, cryptoKrw, unpricedJson, rawJson)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      Date.now(),
      s.exchange,
      s.totalKrw,
      s.cashKrw,
      s.cryptoKrw,
      JSON.stringify(s.unpriced),
      s.raw ? JSON.stringify(s.raw) : null,
    ],
  });
}
