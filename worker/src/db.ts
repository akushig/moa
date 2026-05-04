import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) throw new Error('TURSO_DATABASE_URL not set');

export const db = createClient({ url, authToken });

export type SnapshotInput = {
  exchange: 'upbit' | 'bithumb' | 'binance';
  quoteCurrency: 'KRW' | 'USDT' | 'USDC' | string;
  // 컬럼명은 legacy 'Krw' 지만 단위는 quoteCurrency 통화. binance=USDT.
  totalKrw: string;
  cashKrw: string;
  cryptoKrw: string;
  unpriced: { currency: string; balance: string }[];
  raw?: unknown; // per-coin holdings — 대시보드 평균단가/평가금액 read.
};

// Prisma 가 SQLite/libSQL DateTime 을 INTEGER (epoch ms) 로 매핑.
export async function insertSnapshot(s: SnapshotInput): Promise<void> {
  await db.execute({
    sql: `INSERT INTO BalanceSnapshot
            (takenAt, exchange, quoteCurrency, totalKrw, cashKrw, cryptoKrw, unpricedJson, rawJson)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      Date.now(),
      s.exchange,
      s.quoteCurrency,
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

// Day 3+ — incremental ingestion 용. (exchange, assetSymbol) 별 마지막
// 거래 timestamp (epoch ms). 없으면 null → caller 가 첫 ingest 로 backward walk.
export async function getLatestOrderTimestamp(
  exchange: 'upbit' | 'bithumb',
  assetSymbol: string,
): Promise<number | null> {
  return latestTimestamp(exchange, assetSymbol, ['buy', 'sell']);
}

// (exchange) 별 마지막 deposit/withdraw timestamp. transfers 는 currency 단위 단일
// API 라 코인별 since 보다는 전체 since 가 더 단순. 안전 마진 1시간 overlap 으로
// fetcher 가 cover.
export async function getLatestTransferTimestamp(
  exchange: 'upbit' | 'bithumb',
): Promise<number | null> {
  return latestTimestamp(exchange, null, ['deposit', 'withdraw']);
}

async function latestTimestamp(
  exchange: string,
  assetSymbol: string | null,
  sides: string[],
): Promise<number | null> {
  const placeholders = sides.map(() => '?').join(', ');
  const sql = `SELECT MAX(timestamp) AS ts FROM "Transaction"
               WHERE source = 'exchange' AND exchange = ?
                 ${assetSymbol ? 'AND assetSymbol = ?' : ''}
                 AND side IN (${placeholders})`;
  const args: (string | number)[] = [exchange];
  if (assetSymbol) args.push(assetSymbol);
  args.push(...sides);
  const r = await db.execute({ sql, args });
  const v = r.rows[0]?.ts as unknown;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type PriceSnapshotInput = {
  market: string; // KRW-BTC, USDT-BTC
  price: string;
  source: string; // upbit | bithumb | binance ...
};

// /sync 시 holdings 의 현재가들을 1행씩 PriceSnapshot 에 적재. 시점별 자산
// 평가의 raw material. 동일 takenAt 으로 묶어 batch insert.
export async function insertPriceSnapshots(
  takenAt: number,
  rows: PriceSnapshotInput[],
): Promise<void> {
  if (rows.length === 0) return;
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO "PriceSnapshot" (takenAt, market, price, source) VALUES (?, ?, ?, ?)`,
      args: [takenAt, r.market, r.price, r.source],
    });
  }
}

export async function insertFxRate(
  takenAt: number,
  base: string,
  quote: string,
  rate: string,
  source: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO "FxRate" (takenAt, base, quote, rate, source) VALUES (?, ?, ?, ?, ?)`,
    args: [takenAt, base, quote, rate, source],
  });
}
