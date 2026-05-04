import { prisma } from '@/lib/db';
import { Decimal, formatKrw } from '@/lib/decimal';
import { computeHoldingsAt } from '@/lib/calc/holdings-at';
import { fetchPricesForHoldings } from '@/lib/calc/historical-price';
import { groupCostBasis } from '@/lib/calc/cost-basis';
import { getFxAtOrNearest } from '@/lib/calc/fx';
import { DateForm } from './date-form';

export const dynamic = 'force-dynamic';

type SP = Promise<{ at?: string }>;

function parseAt(at: string | undefined): { ms: number; iso: string; label: string } {
  if (!at) {
    const now = Date.now();
    return { ms: now, iso: new Date(now).toISOString().slice(0, 10), label: '현재' };
  }
  // "YYYY-MM-DD" or full ISO
  const parsed = at.includes('T') ? new Date(at) : new Date(`${at}T23:59:59+09:00`);
  if (Number.isNaN(parsed.getTime())) {
    return { ms: Date.now(), iso: '', label: '잘못된 날짜' };
  }
  return {
    ms: parsed.getTime(),
    iso: at.slice(0, 10),
    label: parsed.toLocaleDateString('ko-KR'),
  };
}

async function load(asOfMs: number) {
  // 그 시점까지의 모든 exchange transactions
  const txs = await prisma.transaction.findMany({
    where: {
      source: 'exchange',
      timestamp: { lte: new Date(asOfMs) },
    },
    orderBy: { timestamp: 'asc' },
  });

  // 1) qty 복원
  const holdings = computeHoldingsAt(
    txs.map((t) => ({
      exchange: t.exchange,
      assetSymbol: t.assetSymbol,
      timestamp: t.timestamp,
      side: t.side,
      qty: t.qty as unknown as { toString(): string },
    })),
    asOfMs,
  );

  // 2) cost basis 복원
  const cb = groupCostBasis(
    txs.map((t) => ({
      exchange: t.exchange,
      assetSymbol: t.assetSymbol,
      timestamp: t.timestamp,
      side: t.side,
      qty: t.qty as unknown as { toString(): string },
      price: t.price as unknown as { toString(): string },
      fee: t.fee as unknown as { toString(): string },
    })),
  );

  // 3) 그 시점 가격 + USDT/KRW 환율 (binance row 환산용) 병렬
  const [priceMap, fxAt] = await Promise.all([
    fetchPricesForHoldings(holdings, asOfMs),
    getFxAtOrNearest('USDT', 'KRW', asOfMs),
  ]);

  return { txs, holdings, cb, priceMap, fxAt };
}

export default async function AssetAtPage({ searchParams }: { searchParams: SP }) {
  const params = await searchParams;
  const at = parseAt(params.at);

  let r: Awaited<ReturnType<typeof load>>;
  try {
    r = await load(at.ms);
  } catch (err) {
    return (
      <main className="p-8 max-w-4xl mx-auto">
        <h1 className="text-sm text-[var(--muted)] uppercase tracking-wider">{at.label} 자산</h1>
        <DateForm initial={at.iso} />
        <p className="mt-6 text-[var(--negative)]">로드 실패: {err instanceof Error ? err.message : String(err)}</p>
      </main>
    );
  }

  // binance row 의 raw 값 (price/avgPrice/realizedPnl) 은 USDT 단위 → 그 시점 fx 곱해 KRW 통일.
  // fx 없으면 binance row 미환산 (null) 으로 표시.
  const fx = r.fxAt;
  const rows = r.holdings
    .map((h) => {
      const cbEntry = r.cb.get(`${h.exchange}::${h.symbol}`);
      const rawPrice = r.priceMap.get(`${h.exchange}::${h.symbol}`) ?? null;
      const rawAvg = cbEntry && cbEntry.trackedQty.gt(0) ? cbEntry.avgPrice : null;
      const rawRealized = cbEntry?.realizedPnl ?? null;
      const isBinance = h.exchange === 'binance';
      const toKrw = (d: Decimal | null): Decimal | null => {
        if (d === null) return null;
        if (!isBinance) return d;
        if (!fx) return null;
        return d.times(fx.rate);
      };
      const price = toKrw(rawPrice);
      const avgPrice = toKrw(rawAvg);
      const realized = toKrw(rawRealized);
      const value = price ? h.qty.times(price) : null;
      const costBasis = avgPrice ? avgPrice.times(h.qty) : null;
      const unrealized = value && costBasis ? value.minus(costBasis) : null;
      const pct =
        unrealized && costBasis && costBasis.gt(0) ? unrealized.div(costBasis).times(100) : null;
      return {
        exchange: h.exchange,
        symbol: h.symbol,
        qty: h.qty,
        price,
        value,
        avgPrice,
        unrealized,
        pct,
        realized,
        isBinance,
      };
    })
    .sort((a, b) => {
      const av = a.value ? a.value.toNumber() : -1;
      const bv = b.value ? b.value.toNumber() : -1;
      return bv - av;
    });

  const totalValue = rows.reduce((acc, h) => (h.value ? acc.plus(h.value) : acc), new Decimal(0));
  // 누적 실현손익 — binance(USDT) 는 그 시점 환율로 KRW 환산해서 합산. fx 없으면 binance 분 제외.
  let totalRealized = new Decimal(0);
  for (const [k, v] of r.cb.entries()) {
    const exchange = k.split('::')[0];
    if (exchange === 'binance') {
      if (fx) totalRealized = totalRealized.plus(v.realizedPnl.times(fx.rate));
    } else {
      totalRealized = totalRealized.plus(v.realizedPnl);
    }
  }
  const txCount = r.txs.length;
  const unpriced = rows.filter((h) => h.price === null);

  return (
    <main className="p-8 max-w-4xl mx-auto">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-sm text-[var(--muted)] uppercase tracking-wider">
            {at.label} 시점 자산
          </h1>
          <div className="mt-2 text-5xl font-semibold">{formatKrw(totalValue)}</div>
          <div className="mt-2 text-xs text-[var(--muted)]">
            거래소 코인 평가합 · 거래내역 {txCount.toLocaleString('ko-KR')}건 replay · 누적 실현손익{' '}
            <span className={totalRealized.gte(0) ? '' : 'text-[var(--negative)]'}>
              {totalRealized.gte(0) ? '+' : ''}
              {formatKrw(totalRealized)}
            </span>
          </div>
        </div>
        <DateForm initial={at.iso} />
      </div>

      <p className="mt-3 text-[10px] text-[var(--muted)]">
        매수/매도/입금/출금 transaction 만 사용해 그 시점 보유수량 복원 → 그 시점 시장가 (PriceSnapshot 우선, 없으면 거래소
        분봉/일봉 API) 으로 평가. BalanceSnapshot 의 actual qty 와 약간 다를 수 있음 (거래소 내부 fee/조정 미반영).
        {fx && (
          <>
            {' '}binance USDT → KRW 환산: <span className="font-mono">{formatKrw(fx.rate)}/USDT</span>{' '}
            ({new Date(fx.takenAt).toLocaleDateString('ko-KR')} FxRate).
          </>
        )}
        {!fx && rows.some((row) => row.isBinance) && (
          <span className="text-[var(--negative)]"> · binance 환율 데이터 없음 → 미환산</span>
        )}
      </p>

      {rows.length > 0 ? (
        <section className="mt-8 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-[var(--muted)] border-b border-white/10">
                <th className="text-left font-normal py-2">거래소</th>
                <th className="text-left font-normal py-2">코인</th>
                <th className="text-right font-normal py-2">수량</th>
                <th className="text-right font-normal py-2">평균단가</th>
                <th className="text-right font-normal py-2">시점 시세</th>
                <th className="text-right font-normal py-2">평가금액</th>
                <th className="text-right font-normal py-2">평가손익</th>
                <th className="text-right font-normal py-2">실현손익</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={`${h.exchange}-${h.symbol}-${i}`} className="border-b border-white/5">
                  <td className="py-2 text-[var(--muted)]">{h.exchange}</td>
                  <td className="py-2">
                    {h.symbol}
                    {h.price === null && (
                      <span className="ml-1 text-[10px] text-[var(--negative)]">미환산</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{trimQty(h.qty)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {h.avgPrice ? formatKrw(h.avgPrice) : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {h.price ? formatKrw(h.price) : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {h.value ? formatKrw(h.value) : '—'}
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
                    className={`py-2 text-right tabular-nums ${h.realized && h.realized.lt(0) ? 'text-[var(--negative)]' : ''}`}
                  >
                    {h.realized && !h.realized.eq(0) ? (
                      <>
                        {h.realized.gte(0) ? '+' : ''}
                        {formatKrw(h.realized)}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <p className="mt-8 text-[var(--muted)] text-sm">
          {at.label} 이전 거래내역 없음 (또는 보유 0).
        </p>
      )}

      {unpriced.length > 0 && (
        <p className="mt-4 text-[10px] text-[var(--muted)]">
          미환산 (그 시점 KRW 마켓 데이터 없음): {unpriced.map((u) => `${u.exchange} ${u.symbol}`).join(', ')}
        </p>
      )}

      <div className="mt-8 text-xs">
        <a href="/" className="text-[var(--muted)] hover:underline">
          ← 현재 대시보드로
        </a>
      </div>
    </main>
  );
}

function trimQty(qty: Decimal): string {
  if (qty.eq(0)) return '0';
  const s = qty.toFixed(8);
  return s.replace(/\.?0+$/, '');
}
