import type { BalanceSnapshot, Transaction } from '@prisma/client';
import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/decimal';
import { loadManualAssets, summarizeManual } from '@/lib/manual-assets';
import { computeTotalAssets, type ExchangeBreakdown } from '@/lib/calc/total-assets';
import { groupCostBasis } from '@/lib/calc/cost-basis';
import { formatKrw } from '@/lib/decimal';
import { SyncButton } from './sync-button';

export const dynamic = 'force-dynamic';

type Holding = {
  currency: string;
  qty: string;
  avgBuyPrice: string; // 거래소 측 값
  unitCurrency: string;
  priceKrw: string | null;
  valueKrw: string | null;
  source: 'krw_market' | 'fx' | 'unpriced';
};

function rowToBreakdown(row: BalanceSnapshot): {
  exchange: string;
  takenAt: Date;
  breakdown: ExchangeBreakdown;
  holdings: Holding[];
} {
  const unpriced = (() => {
    try {
      return JSON.parse(row.unpricedJson) as { currency: string; balance: string }[];
    } catch {
      return [];
    }
  })();
  const holdings = (() => {
    if (!row.rawJson) return [];
    try {
      const j = JSON.parse(row.rawJson) as { holdings?: Holding[] };
      return Array.isArray(j.holdings) ? j.holdings : [];
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
    holdings,
  };
}

async function load() {
  const [upbitRow, bithumbRow, txs, manualRaw] = await Promise.all([
    prisma.balanceSnapshot.findFirst({
      where: { exchange: 'upbit' },
      orderBy: { takenAt: 'desc' },
    }),
    prisma.balanceSnapshot.findFirst({
      where: { exchange: 'bithumb' },
      orderBy: { takenAt: 'desc' },
    }),
    prisma.transaction.findMany({
      where: { source: 'exchange' },
      orderBy: { timestamp: 'asc' },
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

  // (exchange, symbol) → CostBasis
  const cb = groupCostBasis(
    txs.map((t: Transaction) => ({
      exchange: t.exchange,
      assetSymbol: t.assetSymbol,
      timestamp: t.timestamp,
      side: t.side,
      qty: t.qty as unknown as { toString(): string },
      price: t.price as unknown as { toString(): string },
      fee: t.fee as unknown as { toString(): string },
    })),
  );

  // 누적 실현손익 합계 (모든 (exchange, symbol) 의 realizedPnl 합)
  const totalRealized = Array.from(cb.values()).reduce(
    (acc, v) => acc.plus(v.realizedPnl),
    new Decimal(0),
  );

  return { exchanges, total, unpriced, cb, txCount: txs.length, totalRealized };
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

  // (exchange, symbol) → 보유 holding + cost basis 결합
  // moaAvg = Transaction 기반 이동평균 (deposit 제외, withdraw 비례차감)
  // exchangeAvg = 거래소가 알려주는 avg_buy_price (참고용)
  const holdingRows = r.exchanges.flatMap((e) =>
    e.holdings
      .filter((h) => new Decimal(h.qty).gt(0))
      .map((h) => {
        const cb = r.cb.get(`${e.exchange}::${h.currency}`);
        const priceKrw = h.priceKrw ? new Decimal(h.priceKrw) : null;
        const valueKrw = h.valueKrw ? new Decimal(h.valueKrw) : null;
        const moaAvg = cb && cb.trackedQty.gt(0) ? cb.avgPrice : null;
        const exchangeAvgRaw = h.avgBuyPrice ? new Decimal(h.avgBuyPrice) : null;
        const exchangeAvg = exchangeAvgRaw && exchangeAvgRaw.gt(0) ? exchangeAvgRaw : null;
        // 표시용 평균단가: moa 우선, 없으면 거래소
        const avgPrice = moaAvg ?? exchangeAvg;
        const costBasis = avgPrice && new Decimal(h.qty).gt(0)
          ? avgPrice.times(h.qty)
          : null;
        const unrealized = valueKrw && costBasis ? valueKrw.minus(costBasis) : null;
        const pct = costBasis && costBasis.gt(0) && unrealized
          ? unrealized.div(costBasis).times(100)
          : null;
        return {
          exchange: e.exchange,
          currency: h.currency,
          qty: h.qty,
          priceKrw,
          valueKrw,
          moaAvg,
          exchangeAvg,
          avgPrice,
          costBasis,
          unrealized,
          pct,
          source: h.source,
          realizedPnl: cb?.realizedPnl ?? null,
        };
      }),
  );
  // 평가금액 큰 순 정렬
  holdingRows.sort((a, b) => {
    const av = a.valueKrw ? a.valueKrw.toNumber() : -1;
    const bv = b.valueKrw ? b.valueKrw.toNumber() : -1;
    return bv - av;
  });

  return (
    <main className="p-8 max-w-4xl mx-auto">
      <div className="flex items-baseline justify-between">
        <h1 className="text-sm text-[var(--muted)] uppercase tracking-wider">총자산</h1>
        <div className="flex gap-2 items-center">
          <a href="/asset" className="text-xs text-[var(--muted)] hover:text-white">
            특정 시점 조회
          </a>
          <SyncButton />
        </div>
      </div>
      <div className="mt-2 text-5xl font-semibold">{formatKrw(totalKrw)}</div>
      <div className="mt-2 text-xs text-[var(--muted)]">
        최근 동기화: {lastSyncStr} · 거래내역 {r.txCount.toLocaleString('ko-KR')}건 · 누적 실현손익{' '}
        <span className={r.totalRealized.gte(0) ? '' : 'text-[var(--negative)]'}>
          {r.totalRealized.gte(0) ? '+' : ''}
          {formatKrw(r.totalRealized)}
        </span>
      </div>

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

      {holdingRows.length > 0 && (
        <section className="mt-12">
          <h2 className="text-sm text-[var(--muted)] uppercase tracking-wider mb-3">보유 코인</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-[var(--muted)] border-b border-white/10">
                  <th className="text-left font-normal py-2">거래소</th>
                  <th className="text-left font-normal py-2">코인</th>
                  <th className="text-right font-normal py-2">수량</th>
                  <th className="text-right font-normal py-2">moa 평균</th>
                  <th className="text-right font-normal py-2">거래소 평균</th>
                  <th className="text-right font-normal py-2">현재가</th>
                  <th className="text-right font-normal py-2">평가금액</th>
                  <th className="text-right font-normal py-2">평가손익</th>
                  <th className="text-right font-normal py-2">실현손익</th>
                </tr>
              </thead>
              <tbody>
                {holdingRows.map((h, i) => {
                  const diff =
                    h.moaAvg && h.exchangeAvg && h.exchangeAvg.gt(0)
                      ? h.moaAvg.minus(h.exchangeAvg).div(h.exchangeAvg).times(100)
                      : null;
                  return (
                    <tr key={`${h.exchange}-${h.currency}-${i}`} className="border-b border-white/5">
                      <td className="py-2 text-[var(--muted)]">{h.exchange}</td>
                      <td className="py-2">
                        {h.currency}
                        {h.source === 'fx' && (
                          <span className="ml-1 text-[10px] text-[var(--muted)]">fx</span>
                        )}
                        {h.source === 'unpriced' && (
                          <span className="ml-1 text-[10px] text-[var(--negative)]">미환산</span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">{trimQty(h.qty)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {h.moaAvg ? formatKrw(h.moaAvg) : '—'}
                        {diff && diff.abs().gte(1) && (
                          <span
                            className={`ml-1 text-[10px] ${diff.lt(0) ? 'text-[var(--negative)]' : 'text-[var(--muted)]'}`}
                            title={`거래소 대비 ${diff.toFixed(1)}%`}
                          >
                            ({diff.gte(0) ? '+' : ''}
                            {diff.toFixed(1)}%)
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums text-[var(--muted)]">
                        {h.exchangeAvg ? formatKrw(h.exchangeAvg) : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {h.priceKrw ? formatKrw(h.priceKrw) : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {h.valueKrw ? formatKrw(h.valueKrw) : '—'}
                      </td>
                      <td
                        className={`py-2 text-right tabular-nums ${h.unrealized && h.unrealized.lt(0) ? 'text-[var(--negative)]' : ''}`}
                      >
                        {h.unrealized ? (
                          <>
                            {h.unrealized.gte(0) ? '+' : ''}
                            {formatKrw(h.unrealized)}
                            {h.pct && (
                              <span className="ml-1 text-[10px]">
                                ({h.pct.gte(0) ? '+' : ''}
                                {h.pct.toFixed(1)}%)
                              </span>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td
                        className={`py-2 text-right tabular-nums ${h.realizedPnl && h.realizedPnl.lt(0) ? 'text-[var(--negative)]' : ''}`}
                      >
                        {h.realizedPnl && !h.realizedPnl.eq(0) ? (
                          <>
                            {h.realizedPnl.gte(0) ? '+' : ''}
                            {formatKrw(h.realizedPnl)}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-[var(--muted)]">
              <span className="font-mono">moa 평균</span> = 거래내역(매수/매도/출금) 기반 이동평균. 입금(staking 보상 등)은 평균단가 제외 (거래소 convention).{' '}
              <span className="font-mono">거래소 평균</span> = 거래소 API avg_buy_price (참고).{' '}
              <span className="font-mono">fx</span> = stablecoin 환산.
            </p>
          </div>
        </section>
      )}

      {!haveAnySnapshot && (
        <p className="mt-6 text-xs text-[var(--muted)]">
          아직 동기화 기록이 없습니다. 우측 상단 동기화 버튼으로 거래소 잔고를 가져오세요.
        </p>
      )}

      {r.unpriced.length > 0 && (
        <p className="mt-6 text-xs text-[var(--muted)]">
          미환산 잔고 (KRW 마켓 없는 코인):{' '}
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

// 0.0001234500 → 0.00012345 (불필요 trailing zero 제거 + 소수 8 자리 cap)
function trimQty(qty: string): string {
  const d = new Decimal(qty);
  if (d.eq(0)) return '0';
  const s = d.toFixed(8);
  return s.replace(/\.?0+$/, '');
}
