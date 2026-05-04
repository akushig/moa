import { NextResponse } from 'next/server';
import { syncBinance } from '@/lib/exchanges/binance';

export const runtime = 'nodejs';
// Binance 가 GCP us-west1 워커 IP (미국 region) 를 차단 → Vercel function 을 한국
// region (icn1) 에 pin 해서 직접 호출. 워커는 upbit/bithumb 만 담당.
export const preferredRegion = 'icn1';
export const dynamic = 'force-dynamic';

async function callWorker(): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const url = process.env.WORKER_URL;
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!url || !secret) {
    return { ok: false, error: 'WORKER_URL / WORKER_SHARED_SECRET not set in Vercel env' };
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/sync`, {
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

// 동기화: worker (upbit/bithumb) + binance (Vercel 직접) 병렬.
// 둘 중 하나라도 성공하면 ok=true (개별 결과는 results 에).
export async function POST() {
  const [worker, binance] = await Promise.all([callWorker(), syncBinance()]);

  const results: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  if (worker.ok) results.worker = worker.data;
  else errors.worker = worker.error ?? 'worker failed';

  if (binance.ok) {
    results.binance = {
      total: binance.totalUsdt,
      cash: binance.cashUsdt,
      crypto: binance.cryptoUsdt,
      holdingsCount: binance.holdingsCount,
      unpricedCount: binance.unpricedCount,
      walletWarnings: binance.warnings ?? [],
      quoteCurrency: 'USDT',
    };
  } else if (binance.error && !binance.error.includes('not set')) {
    // env 미설정은 silent skip, 그 외 에러만 표시
    errors.binance = binance.error;
  }

  const ok = Object.keys(results).length > 0 && Object.keys(errors).length === 0;
  return NextResponse.json({ ok, results, errors });
}
