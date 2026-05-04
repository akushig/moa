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
  raw?: unknown; // per-coin priced rows (holdings) — 대시보드가 평균단가/평가금액 위해 read.
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

export type TransactionInput = {
  timestamp: number; // epoch ms
  source: 'exchange' | 'manual' | 'csv';
  exchange?: 'upbit' | 'bithumb' | null;
  externalId?: string | null;
  assetClass: 'crypto' | 'stock' | 'cash' | 'loan' | 'realestate';
  assetSymbol: string;
  side: 'buy' | 'sell' | 'deposit' | 'withdraw' | 'interest' | 'dividend';
  qty: string; // Decimal stringified
  price: string;
  fee?: string;
  currency: string;
  note?: string | null;
};

// (source, exchange, externalId) 가 unique → INSERT OR IGNORE 로 idempotent.
// SQLite 는 NULL 끼리 distinct 취급 → externalId=null 인 manual 입력 다중 가능.
export async function upsertTransaction(t: TransactionInput): Promise<{ inserted: boolean }> {
  const r = await db.execute({
    sql: `INSERT OR IGNORE INTO "Transaction"
            (timestamp, source, exchange, externalId, assetClass, assetSymbol,
             side, qty, price, fee, currency, note, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.timestamp,
      t.source,
      t.exchange ?? null,
      t.externalId ?? null,
      t.assetClass,
      t.assetSymbol,
      t.side,
      t.qty,
      t.price,
      t.fee ?? '0',
      t.currency,
      t.note ?? null,
      Date.now(),
    ],
  });
  return { inserted: (r.rowsAffected ?? 0) > 0 };
}

export async function upsertTransactions(
  rows: TransactionInput[],
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const t of rows) {
    const r = await upsertTransaction(t);
    if (r.inserted) inserted += 1;
    else skipped += 1;
  }
  return { inserted, skipped };
}
