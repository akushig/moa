import type { BalanceSnapshot } from '@prisma/client';
import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/decimal';
import { loadManualAssets, summarizeManual } from '@/lib/manual-assets';
import { computeTotalAssets, type ExchangeBreakdown } from '@/lib/calc/total-assets';
import { formatKrw } from '@/lib/decimal';
import { SyncButton } from './sync-button';

export const dynamic = 'force-dynamic';

function rowToBreakdown(row: BalanceSnapshot): {
  exchange: string;
  takenAt: Date;
  breakdown: ExchangeBreakdown;
} {
  const unpriced = (() => {
    try {
      return JSON.parse(row.unpricedJson) as { currency: string; balance: string }[];
    } catch {
      return [];
    }
  })();
  return {
    exchange: row.exchange,
    takenAt: row.takenAt,
    breakdown: {
      totalKrw: new Decimal(String(row.totalKrw)),
      cashKrw: new Decimal(String(row.cashKrw)),
      cryptoKrw: new Decimal(String(row.cryptoKrw)),
      unpriced,
    },
  };
}

async function load() {
  const [upbitRow, bithumbRow, manualRaw] = await Promise.all([
    prisma.balanceSnapshot.findFirst({
      where: { exchange: 'upbit' },
      orderBy: { takenAt: 'desc' },
    }),
    prisma.balanceSnapshot.findFirst({
      where: { exchange: 'bithumb' },
      orderBy: { takenAt: 'desc' },
    }),
    loadManualAssets(),
  ]);
  const exchanges = [upbitRow, bithumbRow]
    .filter((r): r is BalanceSnapshot => r !== null)
    .map(rowToBreakdown);
  const manual = summarizeManual(manualRaw);
  const total = computeTotalAssets(
    exchanges.map((e) => e.breakdown),
    manual,
  );
  const unpriced = exchanges.flatMap((e) => e.breakdown.unpriced);
  return { exchanges, total, unpriced };
}

export default async function Page() {
  let r: Awaited<ReturnType<typeof load>>;
  try {
    r = await load();
  } catch (err) {
    return (
      <main className="p-8">
        <h1 className="text-xl text-[var(--muted)]">moa</h1>
        <div className="mt-8 text-[var(--negative)]">
          <p className="text-lg">데이터 로드 실패</p>
          <pre className="mt-2 text-sm whitespace-pre-wrap">
            {err instanceof Error ? err.message : String(err)}
          </pre>
        </div>
      </main>
    );
  }

  const { totalKrw, parts } = r.total;
  const lastSync = r.exchanges
    .map((e) => e.takenAt.getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const lastSyncStr = lastSync > 0 ? new Date(lastSync).toLocaleString('ko-KR') : '아직 없음';
  const haveAnySnapshot = r.exchanges.length > 0;

  return (
    <main className="p-8 max-w-3xl mx-auto">
      <div className="flex items-baseline justify-between">
        <h1 className="text-sm text-[var(--muted)] uppercase tracking-wider">총자산</h1>
        <SyncButton />
      </div>
      <div className="mt-2 text-5xl font-semibold">{formatKrw(totalKrw)}</div>
      <div className="mt-2 text-xs text-[var(--muted)]">최근 동기화: {lastSyncStr}</div>

      <table className="mt-10 w-full text-sm">
        <tbody>
          <Row label="암호화폐 (거래소 합)" value={parts.crypto.toString()} />
          <Row label="현금 (거래소 KRW 합)" value={parts.cashExchange.toString()} />
          <Row label="현금 (수기)" value={parts.cashManual.toString()} />
          <Row label="부동산 순자산 (전세보증금 - 전세대출)" value={parts.realestateNet.toString()} />
          <Row label="마이너스통장 사용액" value={parts.negativeAccount.toString()} negative />
          <Row label="대출 잔액" value={parts.loan.toString()} negative />
        </tbody>
      </table>

      {!haveAnySnapshot && (
        <p className="mt-6 text-xs text-[var(--muted)]">
          아직 동기화 기록이 없습니다. 우측 상단 동기화 버튼으로 거래소 잔고를 가져오세요.
        </p>
      )}

      {r.unpriced.length > 0 && (
        <p className="mt-6 text-xs text-[var(--muted)]">
          미환산 잔고 (stablecoin 등 — Day 3 fx 통합):{' '}
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
        {negative ? '−' : ''}
        {formatKrw(value)}
      </td>
    </tr>
  );
}
