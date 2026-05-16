import { loadDashboard } from '@/lib/load-dashboard';
import { Decimal } from '@/lib/decimal';
import { formatKrw, formatQuote } from '@/lib/decimal';

export const dynamic = 'force-dynamic';

function pnlColor(d: Decimal | null): string {
  if (!d) return '';
  if (d.gt(0)) return 'text-[var(--accent)]';
  if (d.lt(0)) return 'text-[var(--negative)]';
  return '';
}

function trimQty(qty: string): string {
  const d = new Decimal(qty);
  if (d.eq(0)) return '0';
  return d.toFixed(8).replace(/\.?0+$/, '');
}

export default async function HoldingsPage() {
  const r = await loadDashboard();

  const totalValue = r.holdingRows.reduce(
    (acc, h) => (h.valueKrw ? acc.plus(h.valueKrw) : acc),
    new Decimal(0),
  );

  // 거래소 필터용
  const exchangeNames = [...new Set(r.holdingRows.map((h) => h.exchange))];

  return (
    <main className="p-6 md:p-8 max-w-6xl mx-auto">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-medium">보유 코인</h1>
          <p className="mt-1 text-xs text-[var(--muted)]">
            {r.holdingRows.length}종목 · 거래소 {exchangeNames.length}개 ({exchangeNames.join(', ')})
          </p>
        </div>
        <a href="/" className="text-xs text-[var(--muted)] hover:text-white">
          ← 대시보드
        </a>
      </div>

      {/* 요약 */}
      <div className="mt-4 flex gap-6 text-sm">
        <div>
          <span className="text-[var(--muted)] text-xs">총 평가금액</span>
          <div className="font-semibold tabular-nums">{formatKrw(totalValue)}</div>
        </div>
        <div>
          <span className="text-[var(--muted)] text-xs">평가손익</span>
          <div className={`font-semibold tabular-nums ${pnlColor(r.totalUnrealized)}`}>
            {r.totalUnrealized.gte(0) ? '+' : ''}
            {formatKrw(r.totalUnrealized)}
          </div>
        </div>
        <div>
          <span className="text-[var(--muted)] text-xs">실현손익</span>
          <div className={`font-semibold tabular-nums ${pnlColor(r.totalRealized)}`}>
            {r.totalRealized.gte(0) ? '+' : ''}
            {formatKrw(r.totalRealized)}
          </div>
        </div>
      </div>

      {/* 테이블 */}
      {r.holdingRows.length > 0 ? (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] border-b border-white/10">
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
              {r.holdingRows.map((h, i) => {
                const diff =
                  h.moaAvg && h.exchangeAvg && h.exchangeAvg.gt(0)
                    ? h.moaAvg.minus(h.exchangeAvg).div(h.exchangeAvg).times(100)
                    : null;
                return (
                  <tr key={`${h.exchange}-${h.currency}-${i}`} className="border-b border-white/5">
                    <td className="py-2 text-[var(--muted)] text-xs">{h.exchange}</td>
                    <td className="py-2">
                      {h.currency}
                      <span className="ml-1 text-[10px] text-[var(--muted)]">/{h.quoteCurrency}</span>
                      {h.source === 'fx' && <span className="ml-1 text-[10px] text-[var(--muted)]">fx</span>}
                      {h.source === 'parity' && <span className="ml-1 text-[10px] text-[var(--muted)]">stable</span>}
                      {h.source === 'unpriced' && <span className="ml-1 text-[10px] text-[var(--negative)]">미환산</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">{trimQty(h.qty)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {h.moaAvg ? formatQuote(h.moaAvg, h.quoteCurrency) : '—'}
                      {diff && diff.abs().gte(1) && (
                        <span
                          className={`ml-1 text-[10px] ${diff.lt(0) ? 'text-[var(--negative)]' : 'text-[var(--muted)]'}`}
                          title={`거래소 대비 ${diff.toFixed(1)}%`}
                        >
                          ({diff.gte(0) ? '+' : ''}{diff.toFixed(1)}%)
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-[var(--muted)]">
                      {h.exchangeAvg ? formatQuote(h.exchangeAvg, h.quoteCurrency) : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {h.priceKrw ? formatQuote(h.priceKrw, h.quoteCurrency) : '—'}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {h.valueKrw ? formatQuote(h.valueKrw, h.quoteCurrency) : '—'}
                    </td>
                    <td className={`py-2 text-right tabular-nums ${pnlColor(h.unrealized)}`}>
                      {h.unrealized ? (
                        <>
                          {h.unrealized.gte(0) ? '+' : ''}
                          {formatQuote(h.unrealized, h.quoteCurrency)}
                          {h.pct && (
                            <span className="ml-1 text-[10px] opacity-70">
                              ({h.pct.gte(0) ? '+' : ''}{h.pct.toFixed(1)}%)
                            </span>
                          )}
                        </>
                      ) : '—'}
                    </td>
                    <td className={`py-2 text-right tabular-nums ${pnlColor(h.realizedPnl)}`}>
                      {h.realizedPnl && !h.realizedPnl.eq(0) ? (
                        <>{h.realizedPnl.gte(0) ? '+' : ''}{formatQuote(h.realizedPnl, h.quoteCurrency)}</>
                      ) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-[var(--muted)]">
            <span className="font-mono">moa 평균</span> = 거래내역 기반 이동평균.{' '}
            <span className="font-mono">거래소 평균</span> = 거래소 API avg_buy_price (참고).{' '}
            <span className="font-mono">fx</span> = stablecoin 환산.
          </p>
        </div>
      ) : (
        <p className="mt-8 text-sm text-[var(--muted)]">
          동기화 후 보유 코인이 표시됩니다.
        </p>
      )}
    </main>
  );
}
