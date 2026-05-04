import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Day 3 — 워커 측 /ingest 호출: 거래 내역 (orders) → Transaction 테이블 적재.
// /sync 와 동일하게 shared secret 헤더로 보호.
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
    const res = await fetch(`${url.replace(/\/+$/, '')}/ingest`, {
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
