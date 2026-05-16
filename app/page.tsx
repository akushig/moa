import type { BalanceSnapshot, Transaction } from '@prisma/client';
import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/decimal';
import { loadManualAssets, summarizeManual } from '@/lib/manual-assets';
import { computeTotalAssets, type ExchangeBreakdown } from '@/lib/calc/total-assets';
import { groupCostBasis } from '@/lib/calc/cost-basis';
import { getLatestFxRate } from '@/lib/calc/fx';
import { formatKrw, formatQuote } from '@/lib/decimal';
import { SyncButton } from './sync-button';

export const dynamic = 'force-dynamic';

// holdings 의 priceKrw / valueKrw 단위는 BalanceSnapshot.quoteCurrency 통화
// (upbit/bithumb=KRW, binance=USDT). avgBuyPrice 도 동일.
type Holding = {
  currency: string;
  qty: string;
  avgBuyPrice: string | null;
  unitCurrency: string;
  priceKrw: string | null;
  valueKrw: string | null;
  source: 'krw_market' | 'usdt_market' | 'fx' | 'parity' | 'unpriced';
};

type LoanDebtRow = {
  loanCoin: string;
  totalDebt: string;
  totalDebtUsdt: string | null;
  collateralCoin: string;
  currentLTV: string;
  stale?: boolean; // 직전 snapshot 에서 fallback 한 경우
};

function rowToBreakdown(row: BalanceSnapshot): {
  exchange: string;
  quoteCurrency: string;
  takenAt: Date;
  breakdown: ExchangeBreakdown;
  holdings: Holding[];
  loanDebts: LoanDebtRow[];
} {
  const unpriced = (() => {
    try {
      return JSON.parse(row.unpricedJson) as { currency: string; balance: string }[];
    } catch {
      return [];
    }
  })();
  const parsed = (() => {
    if (!row.rawJson) return { holdings: [] as Holding[], loanDebts: [] as LoanDebtRow[] };
    try {
      const j = JSON.parse(row.rawJson) as {
        holdings?: Holding[];
        loanDebts?: LoanDebtRow[];
      };
      return {
        holdings: Array.isArray(j.holdings) ? j.holdings : [],
        loanDebts: Array.isArray(j.loanDebts) ? j.loanDebts : [],
      };
    } catch {
      return { holdings: [] as Holding[], loanDebts: [] as LoanDebtRow[] };
    }
  })();
  return {
    exchange: row.exchange,
    quoteCurrency: row.quoteCurrency,
    takenAt: row.takenAt,
    breakdown: {
      totalKrw: new Decimal(String(row.totalKrw)),
      cashKrw: new Decimal(String(row.cashKrw)),
      cryptoKrw: new Decimal(String(row.cryptoKrw)),
      unpriced,
    },
    holdings: parsed.holdings,
    loanDebts: parsed.loanDebts,
  };
}

async function load() {
  const [snapshots, txs, manualRaw, fxUsdtKrw] = await Promise.all([
    // 거래소별 최신 1행 (group by 후 max id) — Prisma 가 raw 안 써도 가능하지만 단순 N+1.
    Promise.all(
      ['upbit', 'bithumb', 'binance'].map((ex) =>
        prisma.balanceSnapshot.findFirst({
          where: { exchange: ex },
          orderBy: { takenAt: 'desc' },
        }),
      ),
    ),
    prisma.transaction.findMany({
      where: { source: 'exchange' },
      orderBy: { timestamp: 'asc' },
    }),
    loadManualAssets(),
    getLatestFxRate('USDT', 'KRW'),
  ]);
  const exchanges = snapshots
    .filter((r): r is BalanceSnapshot => r !== null)
    .map(rowToBreakdown);
  const manual = summarizeManual(manualRaw);

  // 비-KRW 거래소 (binance 등) 는 FxRate 로 KRW 환산 후 합산. FX 없으면 총자산에서 제외.
  const breakdownsForTotal: ExchangeBreakdown[] = [];
  for (const e of exchanges) {
    if (e.quoteCurrency === 'KRW') {
      breakdownsForTotal.push(e.breakdown);
      continue;
    }
    if (!fxUsdtKrw) continue;
    // v0.1 에서는 USDT 외 quote 없음. USDC/BUSD 등은 USDT 와 1:1 가정.
    breakdownsForTotal.push({
      totalKrw: e.breakdown.totalKrw.times(fxUsdtKrw.rate),
      cashKrw: e.breakdown.cashKrw.times(fxUsdtKrw.rate),
      cryptoKrw: e.breakdown.cryptoKrw.times(fxUsdtKrw.rate),
      unpriced: e.breakdown.unpriced,
    });
  }

  // 거래소 부채 (binance Crypto Loan totalDebt) — USDT-equiv 합산 → KRW 환산.
  // totalDebtUsdt null (loanCoin USDT 페어 미발견) 항목은 unpricedDebts 로 모음.
  const allDebts = exchanges.flatMap((e) => e.loanDebts);
  let exchangeDebtUsdt = new Decimal(0);
  const unpricedDebts: LoanDebtRow[] = [];
  for (const d of allDebts) {
    if (d.totalDebtUsdt) exchangeDebtUsdt = exchangeDebtUsdt.plus(d.totalDebtUsdt);
    else unpricedDebts.push(d);
  }
  const exchangeDebtKrw = fxUsdtKrw
    ? exchangeDebtUsdt.times(fxUsdtKrw.rate)
    : new Decimal(0);

  const total = computeTotalAssets(breakdownsForTotal, manual, exchangeDebtKrw);

  // quoteCurrency 별 거래소 합계 (분리 표시용).
  const totalsByQuote = new Map<string, { cash: Decimal; crypto: Decimal; total: Decimal }>();
  for (const e of exchanges) {
    const cur = totalsByQuote.get(e.quoteCurrency) ?? {
      cash: new Decimal(0),
      crypto: new Decimal(0),
      total: new Decimal(0),
    };
    cur.cash = cur.cash.plus(e.breakdown.cashKrw);
    cur.crypto = cur.crypto.plus(e.breakdown.cryptoKrw);
    cur.total = cur.total.plus(e.breakdown.totalKrw);
    totalsByQuote.set(e.quoteCurrency, cur);
  }

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

  return {
    exchanges,
    total,
    totalsByQuote,
    unpriced,
    cb,
    txCount: txs.length,
    totalRealized,
    fxUsdtKrw,
    allDebts,
    exchangeDebtUsdt,
    exchangeDebtKrw,
    unpricedDebts,
  };
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
          quoteCurrency: e.quoteCurrency,
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

      {/* 총자산 (KRW). binance USDT 가치는 FxRate(USDT/KRW) 로 환산해 합산됨. */}
      <div className="mt-2 text-5xl font-semibold">{formatKrw(totalKrw)}</div>
      {Array.from(r.totalsByQuote.entries())
        .filter(([q]) => q !== 'KRW')
        .map(([q, v]) => (
          <div key={q} className="mt-2 text-xs text-[var(--muted)]">
            {formatQuote(v.total, q)} (거래소 합)
            {r.fxUsdtKrw && q === 'USDT' && (
              <span className="ml-2">
                · 환율 {formatKrw(r.fxUsdtKrw.rate)}/USDT (Upbit KRW-USDT)
              </span>
            )}
            {!r.fxUsdtKrw && q === 'USDT' && (
              <span className="ml-2 text-[var(--negative)]">
                환율 데이터 없음 — 총자산에서 제외됨
              </span>
            )}
          </div>
        ))}
      <div className="mt-2 text-xs text-[var(--muted)]">
        최근 동기화: {lastSyncStr} · 거래내역 {r.txCount.toLocaleString('ko-KR')}건 · 누적 실현손익{' '}
        <span className={r.totalRealized.gte(0) ? '' : 'text-[var(--negative)]'}>
          {r.totalRealized.gte(0) ? '+' : ''}
          {formatKrw(r.totalRealized)}
        </span>
      </div>

      <table className="mt-10 w-full text-sm">
        <tbody>
          <Row label="암호화폐 (거래소 합, KRW 환산)" value={parts.crypto.toString()} />
          <Row label="현금 (거래소 합, KRW 환산)" value={parts.cashExchange.toString()} />
          <Row label="현금 (수기)" value={parts.cashManual.toString()} />
          <Row label="부동산 순자산 (전세보증금 - 전세대출)" value={parts.realestateNet.toString()} />
          <Row label="마이너스통장 사용액" value={parts.negativeAccount.toString()} negative />
          <Row label="대출 잔액 (수기)" value={parts.loan.toString()} negative />
          {parts.exchangeDebt.gt(0) && (
            <Row
              label="거래소 부채 (Binance Crypto Loan)"
              value={parts.exchangeDebt.toString()}
              negative
            />
          )}
        </tbody>
      </table>
      {r.allDebts.length > 0 && (
        <p className="mt-2 text-[10px] text-[var(--muted)]">
          빌린 코인:{' '}
          {r.allDebts
            .map(
              (d) =>
                `${d.totalDebt} ${d.loanCoin}` +
                (d.collateralCoin ? ` (담보 ${d.collateralCoin}, LTV ${d.currentLTV})` : ''),
            )
            .join(' · ')}
          {r.allDebts.some((d) => d.stale) && (
            <span> · <span className="text-[var(--muted)]">대출 endpoint rate limit 으로 직전 snapshot 사용</span></span>
          )}
          {r.unpricedDebts.length > 0 && (
            <span className="text-[var(--negative)]">
              {' '}· 미환산 부채 {r.unpricedDebts.length}건 (USDT 페어 없음)
            </span>
          )}
        </p>
      )}

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
                        <span className="ml-1 text-[10px] text-[var(--muted)]">/{h.quoteCurrency}</span>
                        {h.source === 'fx' && (
                          <span className="ml-1 text-[10px] text-[var(--muted)]">fx</span>
                        )}
                        {h.source === 'parity' && (
                          <span className="ml-1 text-[10px] text-[var(--muted)]">stable</span>
                        )}
                        {h.source === 'unpriced' && (
                          <span className="ml-1 text-[10px] text-[var(--negative)]">미환산</span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">{trimQty(h.qty)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {h.moaAvg ? formatQuote(h.moaAvg, h.quoteCurrency) : '—'}
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
                        {h.exchangeAvg ? formatQuote(h.exchangeAvg, h.quoteCurrency) : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {h.priceKrw ? formatQuote(h.priceKrw, h.quoteCurrency) : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {h.valueKrw ? formatQuote(h.valueKrw, h.quoteCurrency) : '—'}
                      </td>
                      <td
                        className={`py-2 text-right tabular-nums ${h.unrealized && h.unrealized.lt(0) ? 'text-[var(--negative)]' : ''}`}
                      >
                        {h.unrealized ? (
                          <>
                            {h.unrealized.gte(0) ? '+' : ''}
                            {formatQuote(h.unrealized, h.quoteCurrency)}
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
                            {formatQuote(h.realizedPnl, h.quoteCurrency)}
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
