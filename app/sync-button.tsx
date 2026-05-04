'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function SyncButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inFlight = pending || busy;

  const onClick = async () => {
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch('/api/sync', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) {
        const detail =
          json?.errors && Object.keys(json.errors).length
            ? Object.entries(json.errors)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' | ')
            : json?.error ?? `HTTP ${res.status}`;
        setErr(detail);
      }
      start(() => router.refresh());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {err && <span className="text-xs text-[var(--negative)] max-w-xs truncate" title={err}>{err}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={inFlight}
        className="text-xs px-3 py-1.5 rounded border border-white/15 hover:border-white/30 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {inFlight ? '동기화 중…' : '동기화'}
      </button>
    </div>
  );
}
