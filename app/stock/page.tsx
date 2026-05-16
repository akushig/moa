'use client';

import { useState, useRef } from 'react';

type UploadResult = {
  ok: boolean;
  format?: string;
  parsed?: number;
  inserted?: number;
  skipped?: number;
  error?: string;
  parseErrors?: string[];
  insertErrors?: string[];
};

export default function StockPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const form = new FormData();
      form.set('csv', file);
      const res = await fetch('/api/stock', { method: 'POST', body: form });
      const json = (await res.json()) as UploadResult;
      setResult(json);
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="p-8 max-w-2xl mx-auto">
      <div className="flex items-baseline justify-between">
        <h1 className="text-sm text-[var(--muted)] uppercase tracking-wider">주식 거래내역 업로드</h1>
        <a href="/" className="text-xs text-[var(--muted)] hover:text-white">
          ← 대시보드
        </a>
      </div>

      <p className="mt-4 text-xs text-[var(--muted)] leading-relaxed">
        증권사 HTS/MTS 에서 다운로드한 거래내역 CSV 를 업로드하세요.<br />
        지원: 키움 (영웅문), 삼성 (POP), 미래에셋 (mStock), 범용 CSV.<br />
        필수 컬럼: 일자, 종목코드(또는 종목명), 구분(매수/매도), 수량.<br />
        선택 컬럼: 단가, 수수료, 세금, 시장(KOSPI/KOSDAQ).
      </p>

      <div className="mt-6 flex gap-3 items-center">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt"
          className="text-sm file:mr-3 file:px-3 file:py-1.5 file:rounded file:border file:border-white/15 file:bg-transparent file:text-white file:text-xs file:cursor-pointer hover:file:border-white/30"
        />
        <button
          onClick={upload}
          disabled={busy}
          className="text-xs px-4 py-1.5 rounded border border-white/15 hover:border-white/30 disabled:opacity-40"
        >
          {busy ? '업로드 중…' : '업로드'}
        </button>
      </div>

      {result && (
        <div className={`mt-6 p-4 rounded border ${result.ok ? 'border-[var(--accent)]/30' : 'border-[var(--negative)]/30'}`}>
          {result.ok ? (
            <>
              <p className="text-sm">
                {result.format} 형식 감지 · {result.parsed}건 파싱 · {result.inserted}건 저장 · {result.skipped}건 중복 스킵
              </p>
              {result.parseErrors && result.parseErrors.length > 0 && (
                <details className="mt-2 text-[11px] text-[var(--muted)]">
                  <summary className="cursor-pointer">파싱 경고 {result.parseErrors.length}건</summary>
                  <ul className="mt-1 list-disc pl-4">
                    {result.parseErrors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--negative)]">{result.error}</p>
          )}
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-sm text-[var(--muted)] uppercase tracking-wider mb-2">CSV 형식 예시</h2>
        <pre className="text-[11px] text-[var(--muted)] bg-white/5 rounded p-3 overflow-x-auto">
{`일자,종목코드,종목명,구분,수량,단가,수수료,세금
2024-03-15,005930,삼성전자,매수,10,72000,1500,0
2024-04-20,005930,삼성전자,매도,5,78000,1500,975
2024-05-01,035720,카카오,매수,20,45000,2000,0`}
        </pre>
      </div>

      <div className="mt-8 text-xs">
        <a href="/" className="text-[var(--muted)] hover:underline">
          ← 현재 대시보드로
        </a>
      </div>
    </main>
  );
}
