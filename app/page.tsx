import { getUpbitKrwBreakdown } from '@/lib/exchanges/upbit';
import { loadManualAssets, summarizeManual } from '@/lib/manual-assets';
import { computeTotalAssets } from '@/lib/calc/total-assets';
import { formatKrw } from '@/lib/decimal';

export const dynamic = 'force-dynamic';

type Result =
  | { ok: true; total: ReturnType<typeof computeTotalAssets>; unpriced: { currency: string; balance: string }[] }
  | { ok: false; error: string };

async function load(): Promise<Result> {
  try {
    const [upbit, manual] = await Promise.all([
      getUpbitKrwBreakdown(),
      loadManualAssets().then(summarizeManual),
    ]);
    return { ok: true, total: computeTotalAssets(upbit, manual), unpriced: upbit.unpriced };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function Page() {
  const r = await load();

  if (!r.ok) {
    return (
      <main className="p-8">
        <h1 className="text-xl text-[var(--muted)]">moa</h1>
        <div className="mt-8 text-[var(--negative)]">
          <p className="text-lg">데이터 로드 실패</p>
          <pre className="mt-2 text-sm whitespace-pre-wrap">{r.error}</pre>
          <p className="mt-4 text-sm text-[var(--muted)]">
            .env.local 의 UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY 확인 후 새로고침
          </p>
        </div>
      </main>
    );
  }

  const { totalKrw, parts } = r.total;

  return (
    <main className="p-8 max-w-3xl mx-auto">
      <h1 className="text-sm text-[var(--muted)] uppercase tracking-wider">총자산</h1>
      <div className="mt-2 text-5xl font-semibold">{formatKrw(totalKrw)}</div>

      <table className="mt-10 w-full text-sm">
        <tbody>
          <Row label="암호화폐 (업비트)" value={parts.crypto.toString()} />
          <Row label="현금 (업비트 KRW)" value={parts.cashExchange.toString()} />
          <Row label="현금 (수기)" value={parts.cashManual.toString()} />
          <Row label="부동산 순자산 (전세보증금 - 전세대출)" value={parts.realestateNet.toString()} />
          <Row label="마이너스통장 사용액" value={parts.negativeAccount.toString()} negative />
          <Row label="대출 잔액" value={parts.loan.toString()} negative />
        </tbody>
      </table>

      {r.unpriced.length > 0 && (
        <p className="mt-6 text-xs text-[var(--muted)]">
          미환산 잔고 (stablecoin 등 — Day 2-3 fx 통합):{' '}
          {r.unpriced.map((u) => `${u.currency} ${u.balance}`).join(', ')}
        </p>
      )}
    </main>
  );
}

function Row({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <tr className="border-b border-white/5">
      <td className="py-2 text-[var(--muted)]">{label}</td>
      <td className={`py-2 text-right ${negative ? 'text-[var(--negative)]' : ''}`}>
        {negative ? '−' : ''}{formatKrw(value)}
      </td>
    </tr>
  );
}
