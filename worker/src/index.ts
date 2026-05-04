import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { timingSafeEqual } from 'node:crypto';
import { getUpbitKrwBreakdown } from './exchanges/upbit.js';
import { getBithumbKrwBreakdown } from './exchanges/bithumb.js';
import { insertSnapshot } from './db.js';
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

  await Promise.all([
    (async () => {
      try {
        const r = await getUpbitKrwBreakdown();
        await insertSnapshot({
          exchange: 'upbit',
          totalKrw: r.totalKrw.toString(),
          cashKrw: r.cashKrw.toString(),
          cryptoKrw: r.cryptoKrw.toString(),
          unpriced: r.unpriced,
          raw: { holdings: r.holdings },
        });
        results.upbit = {
          totalKrw: r.totalKrw.toString(),
          cashKrw: r.cashKrw.toString(),
          cryptoKrw: r.cryptoKrw.toString(),
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
          totalKrw: r.totalKrw.toString(),
          cashKrw: r.cashKrw.toString(),
          cryptoKrw: r.cryptoKrw.toString(),
          unpriced: r.unpriced,
          raw: { holdings: r.holdings },
        });
        results.bithumb = {
          totalKrw: r.totalKrw.toString(),
          cashKrw: r.cashKrw.toString(),
          cryptoKrw: r.cryptoKrw.toString(),
          unpricedCount: r.unpriced.length,
          holdingsCount: r.holdings.length,
        };
      } catch (e) {
        errors.bithumb = e instanceof Error ? e.message : String(e);
      }
    })(),
  ]);

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
