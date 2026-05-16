import { loadDashboard, type ExchangeSummary } from '@/lib/load-dashboard';
import { Decimal } from '@/lib/decimal';
import { formatKrw, formatQuote } from '@/lib/decimal';
import { SyncButton } from './sync-button';
import { AssetChart } from './components/asset-chart';
import { AllocationChart } from './components/allocation-chart';

export const dynamic = 'force-dynamic';

function fmtCompact(d: Decimal): string {
  const n = d.toNumber();
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}억`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(0)}만`;
  return n.toLocaleString('ko-KR');
}

function signed(d: Decimal): string {
  return `${d.gte(0) ? '+' : ''}${fmtCompact(d)}원`;
}

function pnlColor(d: Decimal | null): string {
  if (!d) return '';
  if (d.gt(0)) return 'text-[var(--accent)]';
  if (d.lt(0)) return 'text-[var(--negative)]';
  return '';
}

export default async function Page() {
  let r: Awaited<ReturnType<typeof loadDashboard>>;
  try {
    r = await loadDashboard();
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
  const lastSync = r.exchanges.map((e) => e.takenAt.getTime()).reduce((a, b) => Math.max(a, b), 0);
  const lastSyncStr = lastSync > 0 ? new Date(lastSync).toLocaleString('ko-KR') : '아직 없음';
  const haveAnySnapshot = r.exchanges.length > 0;

  // Top 5 코인
  const top5 = r.holdingRows.slice(0, 5);

  return (
    <main className="p-6 md:p-8 max-w-5xl mx-auto">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium tracking-tight">moa</h1>
        <div className="flex gap-2 items-center">
          <NavLink href="/holdings">보유 코인</NavLink>
          <NavLink href="/asset">시점 조회</NavLink>
          <NavLink href="/stock">주식 CSV</NavLink>
          <SyncButton />
        </div>
      </div>

      {/* 총자산 히어로 */}
      <section className="mt-6">
        <p className="text-xs text-[var(--muted)] uppercase tracking-wider">순자산</p>
        <div className="mt-1 text-4xl md:text-5xl font-semibold tabular-nums">{formatKrw(totalKrw)}</div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
          <span>최근 동기화 {lastSyncStr}</span>
          <span>거래내역 {r.txCount.toLocaleString('ko-KR')}건</span>
          <span className={pnlColor(r.totalUnrealized)}>
            평가손익 {signed(r.totalUnrealized)}
          </span>
          <span className={pnlColor(r.totalRealized)}>
            실현손익 {signed(r.totalRealized)}
          </span>
        </div>
      </section>

      {/* 거래소별 카드 */}
      {haveAnySnapshot && (
        <section className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {r.exchangeSummaries.map((ex) => (
            <ExchangeCard key={ex.exchange} ex={ex} />
          ))}
        </section>
      )}

      {/* 자산 구성 테이블 */}
      <section className="mt-8">
        <p className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">자산 구성</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <StatBox label="암호화폐" value={parts.crypto} />
          <StatBox label="현금 (거래소)" value={parts.cashExchange} />
          <StatBox label="현금 (수기)" value={parts.cashManual} />
          <StatBox label="부동산 순자산" value={parts.realestateNet} />
          {parts.negativeAccount.gt(0) && (
            <StatBox label="마이너스통장" value={parts.negativeAccount} negative />
          )}
          {parts.loan.gt(0) && <StatBox label="대출 (수기)" value={parts.loan} negative />}
          {parts.exchangeDebt.gt(0) && (
            <StatBox label="거래소 부채" value={parts.exchangeDebt} negative />
          )}
        </div>
      </section>

      {/* 차트 */}
      {haveAnySnapshot && (
        <section className="mt-8 grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-6">
          <AssetChart />
          <AllocationChart
            parts={JSON.parse(
              JSON.stringify({
                crypto: parts.crypto.toNumber(),
                cashExchange: parts.cashExchange.toNumber(),
                cashManual: parts.cashManual.toNumber(),
                realestateNet: parts.realestateNet.toNumber(),
                negativeAccount: parts.negativeAccount.toNumber(),
                loan: parts.loan.toNumber(),
                exchangeDebt: parts.exchangeDebt.toNumber(),
              }),
            )}
          />
        </section>
      )}

      {/* Top 코인 미리보기 */}
      {top5.length > 0 && (
        <section className="mt-8">
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-xs text-[var(--muted)] uppercase tracking-wider">주요 보유 코인</p>
            <a href="/holdings" className="text-xs text-[var(--muted)] hover:text-white">
              전체 {r.holdingRows.length}개 →
            </a>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-[var(--muted)] border-b border-white/10">
                  <th className="text-left font-normal py-1.5">거래소</th>
                  <th className="text-left font-normal py-1.5">코인</th>
                  <th className="text-right font-normal py-1.5">평가금액</th>
                  <th className="text-right font-normal py-1.5">평가손익</th>
                  <th className="text-right font-normal py-1.5">실현손익</th>
                </tr>
              </thead>
              <tbody>
                {top5.map((h, i) => (
                  <tr key={`${h.exchange}-${h.currency}-${i}`} className="border-b border-white/5">
                    <td className="py-1.5 text-[var(--muted)] text-xs">{h.exchange}</td>
                    <td className="py-1.5">{h.currency}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {h.valueKrw ? formatQuote(h.valueKrw, h.quoteCurrency) : '—'}
                    </td>
                    <td className={`py-1.5 text-right tabular-nums ${pnlColor(h.unrealized)}`}>
                      {h.unrealized ? (
                        <>
                          {h.unrealized.gte(0) ? '+' : ''}
                          {formatQuote(h.unrealized, h.quoteCurrency)}
                          {h.pct && (
                            <span className="ml-1 text-[10px] opacity-70">
                              {h.pct.gte(0) ? '+' : ''}{h.pct.toFixed(1)}%
                            </span>
                          )}
                        </>
                      ) : '—'}
                    </td>
                    <td className={`py-1.5 text-right tabular-nums ${pnlColor(h.realizedPnl)}`}>
                      {h.realizedPnl && !h.realizedPnl.eq(0) ? (
                        <>{h.realizedPnl.gte(0) ? '+' : ''}{formatQuote(h.realizedPnl, h.quoteCurrency)}</>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 부채 상세 */}
      {r.allDebts.length > 0 && (
        <p className="mt-4 text-[10px] text-[var(--muted)]">
          빌린 코인:{' '}
          {r.allDebts
            .map((d) => `${d.totalDebt} ${d.loanCoin}` + (d.collateralCoin ? ` (담보 ${d.collateralCoin}, LTV ${d.currentLTV})` : ''))
            .join(' · ')}
          {r.allDebts.some((d) => d.stale) && <span> · 대출 endpoint rate limit → 직전 snapshot</span>}
          {r.unpricedDebts.length > 0 && (
            <span className="text-[var(--negative)]"> · 미환산 부채 {r.unpricedDebts.length}건</span>
          )}
        </p>
      )}

      {!haveAnySnapshot && (
        <p className="mt-10 text-sm text-[var(--muted)]">
          아직 동기화 기록이 없습니다. 우측 상단 동기화 버튼으로 거래소 잔고를 가져오세요.
        </p>
      )}

      {r.unpriced.length > 0 && (
        <p className="mt-4 text-[10px] text-[var(--muted)]">
          미환산: {r.unpriced.map((u) => `${u.currency} ${u.balance}`).join(', ')}
        </p>
      )}
    </main>
  );
}

/* ── 컴포넌트 ── */

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} className="text-xs text-[var(--muted)] hover:text-white transition-colors">
      {children}
    </a>
  );
}

function ExchangeCard({ ex }: { ex: ExchangeSummary }) {
  return (
    <div className="rounded-lg border border-white/8 p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium capitalize">{ex.exchange}</span>
        <span className="text-[10px] text-[var(--muted)]">{ex.holdingsCount}종목</span>
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums">{formatKrw(ex.totalKrw)}</div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <div>
          <span className="text-[var(--muted)]">암호화폐</span>
          <span className="ml-1 tabular-nums">{fmtCompact(ex.cryptoKrw)}원</span>
        </div>
        <div>
          <span className="text-[var(--muted)]">현금</span>
          <span className="ml-1 tabular-nums">{fmtCompact(ex.cashKrw)}원</span>
        </div>
        {ex.debtKrw.gt(0) && (
          <div>
            <span className="text-[var(--muted)]">부채</span>
            <span className="ml-1 tabular-nums text-[var(--negative)]">−{fmtCompact(ex.debtKrw)}원</span>
          </div>
        )}
        <div>
          <span className="text-[var(--muted)]">평가손익</span>
          <span className={`ml-1 tabular-nums ${pnlColor(ex.unrealizedKrw)}`}>
            {signed(ex.unrealizedKrw)}
          </span>
        </div>
        <div>
          <span className="text-[var(--muted)]">실현손익</span>
          <span className={`ml-1 tabular-nums ${pnlColor(ex.realizedKrw)}`}>
            {signed(ex.realizedKrw)}
          </span>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, negative }: { label: string; value: Decimal; negative?: boolean }) {
  if (value.eq(0)) return null;
  return (
    <div className="rounded border border-white/5 px-3 py-2">
      <p className="text-[10px] text-[var(--muted)]">{label}</p>
      <p className={`text-sm tabular-nums mt-0.5 ${negative ? 'text-[var(--negative)]' : ''}`}>
        {negative ? '−' : ''}{formatKrw(value)}
      </p>
    </div>
  );
}
