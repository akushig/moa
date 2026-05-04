'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function SyncButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<null | 'sync' | 'ingest'>(null);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = pending || busy !== null;

  const run = async (path: '/api/sync' | '/api/ingest', label: 'sync' | 'ingest') => {
    setErr(null);
    setBusy(label);
    try {
      const res = await fetch(path, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        const detail =
          json?.errors && Object.keys(json.errors).length
            ? Object.entries(json.errors)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' | ')
            : json?.error ?? `HTTP ${res.status}`;
        setErr(`${label}: ${detail}`);
      }
      start(() => router.refresh());
    } catch (e) {
      setErr(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {err && (
        <span className="text-xs text-[var(--negative)] max-w-xs truncate" title={err}>
          {err}
        </span>
      )}
      <button
        type="button"
        onClick={() => run('/api/ingest', 'ingest')}
        disabled={inFlight}
        className="text-xs px-3 py-1.5 rounded border border-white/15 hover:border-white/30 disabled:opacity-40 disabled:cursor-not-allowed"
        title="거래내역(주문) 가져와서 평균단가 갱신"
      >
        {busy === 'ingest' ? '가져오는 중…' : '거래내역'}
      </button>
      <button
        type="button"
        onClick={() => run('/api/sync', 'sync')}
        disabled={inFlight}
        className="text-xs px-3 py-1.5 rounded border border-white/15 hover:border-white/30 disabled:opacity-40 disabled:cursor-not-allowed"
        title="거래소 잔고 → 현재가 갱신"
      >
        {busy === 'sync' ? '동기화 중…' : '동기화'}
      </button>
    </div>
  );
}
