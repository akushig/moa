import { NextResponse } from 'next/server';
import { ingestBinance } from '@/lib/exchanges/binance-ingest';

export const runtime = 'nodejs';
// /sync 와 동일하게 binance 호출은 한국 region 에서 직접 (icn1).
// 워커는 upbit/bithumb 만 담당.
export const preferredRegion = 'icn1';
export const dynamic = 'force-dynamic';

async function callWorker(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const url = process.env.WORKER_URL;
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!url || !secret) {
    return { ok: false, error: 'WORKER_URL / WORKER_SHARED_SECRET not set in Vercel env' };
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/ingest`, {
      method: 'POST',
      headers: { 'x-moa-secret': secret },
      cache: 'no-store',
    });
    const json = await res
      .json()
      .catch(() => ({ ok: false, error: 'invalid worker response' }));
    return { ok: !!(json as { ok?: boolean }).ok, data: json };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function POST() {
  const [worker, binance] = await Promise.all([callWorker(), ingestBinance()]);

  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  if (worker.ok) results.worker = worker.data;
  else errors.worker = worker.error ?? 'worker failed';

  // binance: env 미설정은 silent skip, 그 외 errors[] 길이로 판단.
  const binanceFatal =
    binance.errors.length === 1 && binance.errors[0].includes('not set');
  if (!binanceFatal) {
    results.binance = {
      symbols: binance.symbolsScanned,
      tradesFetched: binance.tradesFetched,
      transfersFetched: binance.transfersFetched,
      dividendsFetched: binance.dividendsFetched,
      inserted: binance.inserted,
      skipped: binance.skipped,
      errors: binance.errors,
    };
    if (binance.errors.length > 0) {
      errors.binance = binance.errors.join(' | ');
    }
  }

  const ok = Object.keys(results).length > 0 && Object.keys(errors).length === 0;
  return NextResponse.json({ ok, results, errors });
}
