import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vercel → GCP 워커 sync proxy.
// 사용자가 대시보드 "동기화" 버튼 누르면 호출 → 워커가 거래소 hit + Turso write.
// shared secret 헤더로 워커 측에서 timingSafeEqual 검증.
export async function POST() {
  const url = process.env.WORKER_URL;
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!url || !secret) {
    return NextResponse.json(
      { ok: false, error: 'WORKER_URL / WORKER_SHARED_SECRET not set in Vercel env' },
      { status: 500 },
    );
  }
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/sync`, {
      method: 'POST',
      headers: { 'x-moa-secret': secret },
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({ ok: false, error: 'invalid worker response' }));
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
