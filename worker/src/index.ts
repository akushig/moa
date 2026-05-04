import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { timingSafeEqual } from 'node:crypto';
import { getUpbitKrwBreakdown } from './exchanges/upbit.js';
import { getBithumbKrwBreakdown } from './exchanges/bithumb.js';
import { getBinanceUsdtBreakdown } from './exchanges/binance.js';
import {
  insertSnapshot,
  insertPriceSnapshots,
  insertFxRate,
  type PriceSnapshotInput,
} from './db.js';
import { ingestUpbit, ingestBithumb } from './ingest.js';

const PORT = Number(process.env.PORT ?? '8080');
const SHARED_SECRET = process.env.WORKER_SHARED_SECRET;
if (!SHARED_SECRET) throw new Error('WORKER_SHARED_SECRET not set');

const app = new Hono();

function authOk(headerVal: string | undefined): boolean {
  if (!headerVal || !SHARED_SECRET) return false;
  const a = Buffer.from(headerVal);
  const b = Buffer.from(SHARED_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

app.get('/', (c) => c.text('moa-worker ok'));

app.post('/sync', async (c) => {
  if (!authOk(c.req.header('x-moa-secret'))) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  const startedAt = Date.now();
  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  // 동일 takenAt 으로 모든 거래소 PriceSnapshot 를 묶음 (시점 정합성)
  const syncTime = Date.now();
  const priceSnapshots: PriceSnapshotInput[] = [];

  await Promise.all([
    (async () => {
      try {
        const r = await getUpbitKrwBreakdown();
        await insertSnapshot({
          exchange: 'upbit',
          quoteCurrency: 'KRW',
          totalKrw: r.totalKrw.toString(),
          cashKrw: r.cashKrw.toString(),
          cryptoKrw: r.cryptoKrw.toString(),
          unpriced: r.unpriced,
          raw: { holdings: r.holdings },
        });
        for (const h of r.holdings) {
          if (h.priceKrw) {
            priceSnapshots.push({
              market: `KRW-${h.currency}`,
              price: h.priceKrw,
              source: 'upbit',
            });
          }
        }
        results.upbit = {
          quoteCurrency: 'KRW',
          total: r.totalKrw.toString(),
          cash: r.cashKrw.toString(),
          crypto: r.cryptoKrw.toString(),
          unpricedCount: r.unpriced.length,
          holdingsCount: r.holdings.length,
        };
      } catch (e) {
        errors.upbit = e instanceof Error ? e.message : String(e);
      }
    })(),
    (async () => {
      try {
        const r = await getBithumbKrwBreakdown();
        await insertSnapshot({
          exchange: 'bithumb',
          quoteCurrency: 'KRW',
          totalKrw: r.totalKrw.toString(),
          cashKrw: r.cashKrw.toString(),
          cryptoKrw: r.cryptoKrw.toString(),
          unpriced: r.unpriced,
          raw: { holdings: r.holdings },
        });
        for (const h of r.holdings) {
          if (h.priceKrw) {
            priceSnapshots.push({
              market: `KRW-${h.currency}`,
              price: h.priceKrw,
              source: 'bithumb',
            });
          }
        }
        results.bithumb = {
          quoteCurrency: 'KRW',
          total: r.totalKrw.toString(),
          cash: r.cashKrw.toString(),
          crypto: r.cryptoKrw.toString(),
          unpricedCount: r.unpriced.length,
          holdingsCount: r.holdings.length,
        };
      } catch (e) {
        errors.bithumb = e instanceof Error ? e.message : String(e);
      }
    })(),
    (async () => {
      // Binance — quote=USDT. 키 미설정이면 무시 (옵셔널).
      if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) return;
      try {
        const r = await getBinanceUsdtBreakdown();
        await insertSnapshot({
          exchange: 'binance',
          quoteCurrency: 'USDT',
          totalKrw: r.totalUsdt.toString(),
          cashKrw: r.cashUsdt.toString(),
          cryptoKrw: r.cryptoUsdt.toString(),
          unpriced: r.unpriced,
          raw: { holdings: r.holdings },
        });
        for (const h of r.holdings) {
          if (h.priceKrw && h.source === 'usdt_market') {
            priceSnapshots.push({
              market: `USDT-${h.currency}`,
              price: h.priceKrw,
              source: 'binance',
            });
          }
        }
        results.binance = {
          quoteCurrency: 'USDT',
          total: r.totalUsdt.toString(),
          cash: r.cashUsdt.toString(),
          crypto: r.cryptoUsdt.toString(),
          unpricedCount: r.unpriced.length,
          holdingsCount: r.holdings.length,
        };
      } catch (e) {
        errors.binance = e instanceof Error ? e.message : String(e);
      }
    })(),
  ]);

  // PriceSnapshot 일괄 적재 (동일 takenAt)
  if (priceSnapshots.length > 0) {
    try {
      await insertPriceSnapshots(syncTime, priceSnapshots);
    } catch (e) {
      errors.price_history = e instanceof Error ? e.message : String(e);
    }
  }

  // fx 가 holdings 환산 시 호출되었으면 캐시에 USD/KRW rate 가 있음 → FxRate 에도 기록
  try {
    const { getUsdKrwRateWithMeta } = await import('./fx.js');
    const fx = await getUsdKrwRateWithMeta();
    if (!fx.cached) {
      // 새로 fetch 된 경우만 (캐시 hit 면 이미 이전 sync 에서 기록됨)
      await insertFxRate(syncTime, 'USD', 'KRW', fx.rate.toString(), fx.source);
    }
  } catch {
    // fx 미사용/실패 시 무시 — sync 본 작업과 무관
  }

  const took = Date.now() - startedAt;
  const ok = Object.keys(results).length > 0 && Object.keys(errors).length === 0;
  return c.json({ ok, took, results, errors });
});

// Day 3 — 거래 내역 ingestion. /v1/orders/closed → Transaction 테이블.
// Idempotent (INSERT OR IGNORE on (source, exchange, externalId)).
app.post('/ingest', async (c) => {
  if (!authOk(c.req.header('x-moa-secret'))) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  const startedAt = Date.now();
  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  const tasks: Promise<void>[] = [
    (async () => {
      try {
        results.upbit = await ingestUpbit();
      } catch (e) {
        errors.upbit = e instanceof Error ? e.message : String(e);
      }
    })(),
    (async () => {
      try {
        results.bithumb = await ingestBithumb();
      } catch (e) {
        errors.bithumb = e instanceof Error ? e.message : String(e);
      }
    })(),
  ];
  await Promise.all(tasks);

  const took = Date.now() - startedAt;
  const ok = Object.keys(results).length > 0 && Object.keys(errors).length === 0;
  return c.json({ ok, took, results, errors });
});

serve({ fetch: app.fetch, port: PORT });
console.log(`moa-worker listening on :${PORT}`);
