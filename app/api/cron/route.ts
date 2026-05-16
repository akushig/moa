import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const preferredRegion = 'icn1';
export const dynamic = 'force-dynamic';

// Vercel Cron 에서 매일 1회 호출 → /api/sync + /api/ingest 순차 실행.
// CRON_SECRET 으로 인증 (Vercel 이 자동 주입하는 Authorization: Bearer <secret>).
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  // CRON_SECRET 설정 시 검증. 미설정이면 Vercel Hobby (cron 미지원) → 수동 호출 허용.
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const base = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const results: Record<string, unknown> = {};
  const errors: string[] = [];

  // 1) Sync — 거래소 잔고 동기화
  try {
    const syncRes = await fetch(`${base}/api/sync`, { method: 'POST' });
    const syncJson = await syncRes.json();
    results.sync = syncJson;
    if (!syncRes.ok) errors.push(`sync: HTTP ${syncRes.status}`);
  } catch (e) {
    errors.push(`sync: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Ingest — 거래내역 수집
  try {
    const ingestRes = await fetch(`${base}/api/ingest`, { method: 'POST' });
    const ingestJson = await ingestRes.json();
    results.ingest = ingestJson;
    if (!ingestRes.ok) errors.push(`ingest: HTTP ${ingestRes.status}`);
  } catch (e) {
    errors.push(`ingest: ${e instanceof Error ? e.message : String(e)}`);
  }

  return NextResponse.json({
    ok: errors.length === 0,
    timestamp: new Date().toISOString(),
    results,
    errors,
  });
}
