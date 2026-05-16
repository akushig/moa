// 대시보드 + 보유코인 페이지에서 공유하는 데이터 로딩.
import type { BalanceSnapshot, Transaction } from '@prisma/client';
import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/decimal';
import { loadManualAssets, summarizeManual, type ManualBreakdown } from '@/lib/manual-assets';
import { computeTotalAssets, type ExchangeBreakdown, type TotalAssets } from '@/lib/calc/total-assets';
import { groupCostBasis, type CostBasis } from '@/lib/calc/cost-basis';
import { getLatestFxRate } from '@/lib/calc/fx';

export type Holding = {
  currency: string;
  qty: string;
  avgBuyPrice: string | null;
  unitCurrency: string;
  priceKrw: string | null;
  valueKrw: string | null;
  source: 'krw_market' | 'usdt_market' | 'fx' | 'parity' | 'unpriced';
};

export type LoanDebtRow = {
  loanCoin: string;
  totalDebt: string;
  totalDebtUsdt: string | null;
  collateralCoin: string;
  currentLTV: string;
  stale?: boolean;
};

export type ExchangeData = {
  exchange: string;
  quoteCurrency: string;
  takenAt: Date;
  breakdown: ExchangeBreakdown;
  holdings: Holding[];
  loanDebts: LoanDebtRow[];
};

export type HoldingRow = {
  exchange: string;
  quoteCurrency: string;
  currency: string;
  qty: string;
  priceKrw: Decimal | null;
  valueKrw: Decimal | null;
  moaAvg: Decimal | null;
  exchangeAvg: Decimal | null;
  avgPrice: Decimal | null;
  costBasis: Decimal | null;
  unrealized: Decimal | null;
  pct: Decimal | null;
  source: string;
  realizedPnl: Decimal | null;
};

// 거래소별 요약 (대시보드 카드용)
export type ExchangeSummary = {
  exchange: string;
  quoteCurrency: string;
  cryptoKrw: Decimal; // 암호화폐 평가 (KRW 환산)
  cashKrw: Decimal;   // 현금 (KRW 환산)
  totalKrw: Decimal;  // crypto + cash (KRW)
  debtKrw: Decimal;   // 부채 (KRW)
  unrealizedKrw: Decimal; // 평가손익 합 (KRW)
  realizedKrw: Decimal;   // 실현손익 합 (KRW)
  holdingsCount: number;
  takenAt: Date;
};

export type DashboardData = {
  exchanges: ExchangeData[];
  total: TotalAssets;
  manual: ManualBreakdown;
  exchangeSummaries: ExchangeSummary[];
  holdingRows: HoldingRow[];
  cb: Map<string, CostBasis>;
  txCount: number;
  totalRealized: Decimal;
  totalUnrealized: Decimal;
  fxUsdtKrw: { rate: Decimal; takenAt: Date } | null;
  allDebts: LoanDebtRow[];
  exchangeDebtKrw: Decimal;
  unpricedDebts: LoanDebtRow[];
  unpriced: { currency: string; balance: string }[];
};

function rowToExchange(row: BalanceSnapshot): ExchangeData {
  const unpriced = (() => {
    try { return JSON.parse(row.unpricedJson) as { currency: string; balance: string }[]; } catch { return []; }
  })();
  const parsed = (() => {
    if (!row.rawJson) return { holdings: [] as Holding[], loanDebts: [] as LoanDebtRow[] };
    try {
      const j = JSON.parse(row.rawJson) as { holdings?: Holding[]; loanDebts?: LoanDebtRow[] };
      return {
        holdings: Array.isArray(j.holdings) ? j.holdings : [],
        loanDebts: Array.isArray(j.loanDebts) ? j.loanDebts : [],
      };
    } catch { return { holdings: [] as Holding[], loanDebts: [] as LoanDebtRow[] }; }
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

export async function loadDashboard(): Promise<DashboardData> {
  const [snapshots, txs, manualRaw, fxUsdtKrw] = await Promise.all([
    Promise.all(
      ['upbit', 'bithumb', 'binance', 'coinone', 'korbit'].map((ex) =>
        prisma.balanceSnapshot.findFirst({ where: { exchange: ex }, orderBy: { takenAt: 'desc' } }),
      ),
    ),
    prisma.transaction.findMany({ where: { source: 'exchange' }, orderBy: { timestamp: 'asc' } }),
    loadManualAssets(),
    getLatestFxRate('USDT', 'KRW'),
  ]);

  const exchanges = snapshots.filter((r): r is BalanceSnapshot => r !== null).map(rowToExchange);
  const manual = summarizeManual(manualRaw);

  const breakdownsForTotal: ExchangeBreakdown[] = [];
  for (const e of exchanges) {
    if (e.quoteCurrency === 'KRW') { breakdownsForTotal.push(e.breakdown); continue; }
    if (!fxUsdtKrw) continue;
    breakdownsForTotal.push({
      totalKrw: e.breakdown.totalKrw.times(fxUsdtKrw.rate),
      cashKrw: e.breakdown.cashKrw.times(fxUsdtKrw.rate),
      cryptoKrw: e.breakdown.cryptoKrw.times(fxUsdtKrw.rate),
      unpriced: e.breakdown.unpriced,
    });
  }

  // 부채
  const allDebts = exchanges.flatMap((e) => e.loanDebts);
  let exchangeDebtUsdt = new Decimal(0);
  const unpricedDebts: LoanDebtRow[] = [];
  for (const d of allDebts) {
    if (d.totalDebtUsdt) exchangeDebtUsdt = exchangeDebtUsdt.plus(d.totalDebtUsdt);
    else unpricedDebts.push(d);
  }
  const exchangeDebtKrw = fxUsdtKrw ? exchangeDebtUsdt.times(fxUsdtKrw.rate) : new Decimal(0);

  const total = computeTotalAssets(breakdownsForTotal, manual, exchangeDebtKrw);
  const unpriced = exchanges.flatMap((e) => e.breakdown.unpriced);

  // cost basis
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

  const totalRealized = Array.from(cb.values()).reduce((acc, v) => acc.plus(v.realizedPnl), new Decimal(0));

  // holding rows
  const holdingRows: HoldingRow[] = exchanges.flatMap((e) =>
    e.holdings
      .filter((h) => new Decimal(h.qty).gt(0))
      .map((h) => {
        const cbEntry = cb.get(`${e.exchange}::${h.currency}`);
        const priceKrw = h.priceKrw ? new Decimal(h.priceKrw) : null;
        const valueKrw = h.valueKrw ? new Decimal(h.valueKrw) : null;
        const moaAvg = cbEntry && cbEntry.trackedQty.gt(0) ? cbEntry.avgPrice : null;
        const exchangeAvgRaw = h.avgBuyPrice ? new Decimal(h.avgBuyPrice) : null;
        const exchangeAvg = exchangeAvgRaw && exchangeAvgRaw.gt(0) ? exchangeAvgRaw : null;
        const avgPrice = moaAvg ?? exchangeAvg;
        const costBasis = avgPrice && new Decimal(h.qty).gt(0) ? avgPrice.times(h.qty) : null;
        const unrealized = valueKrw && costBasis ? valueKrw.minus(costBasis) : null;
        const pct = costBasis && costBasis.gt(0) && unrealized ? unrealized.div(costBasis).times(100) : null;
        return {
          exchange: e.exchange,
          quoteCurrency: e.quoteCurrency,
          currency: h.currency,
          qty: h.qty,
          priceKrw, valueKrw, moaAvg, exchangeAvg, avgPrice, costBasis, unrealized, pct,
          source: h.source,
          realizedPnl: cbEntry?.realizedPnl ?? null,
        };
      }),
  );
  holdingRows.sort((a, b) => (b.valueKrw?.toNumber() ?? -1) - (a.valueKrw?.toNumber() ?? -1));

  const totalUnrealized = holdingRows.reduce(
    (acc, h) => (h.unrealized ? acc.plus(h.unrealized) : acc),
    new Decimal(0),
  );

  // 거래소별 요약 카드 데이터
  const exchangeSummaries: ExchangeSummary[] = exchanges.map((e) => {
    const fxRate = e.quoteCurrency !== 'KRW' && fxUsdtKrw ? fxUsdtKrw.rate : new Decimal(1);
    const cryptoKrw = e.breakdown.cryptoKrw.times(fxRate);
    const cashKrw = e.breakdown.cashKrw.times(fxRate);

    // 이 거래소의 평가손익/실현손익
    const exHoldings = holdingRows.filter((h) => h.exchange === e.exchange);
    const unrealizedKrw = exHoldings.reduce((acc, h) => {
      if (!h.unrealized) return acc;
      return acc.plus(h.quoteCurrency !== 'KRW' && fxUsdtKrw ? h.unrealized.times(fxUsdtKrw.rate) : h.unrealized);
    }, new Decimal(0));
    const realizedKrw = exHoldings.reduce((acc, h) => {
      if (!h.realizedPnl) return acc;
      return acc.plus(h.quoteCurrency !== 'KRW' && fxUsdtKrw ? h.realizedPnl.times(fxUsdtKrw.rate) : h.realizedPnl);
    }, new Decimal(0));

    // 이 거래소 부채
    const debtKrw = e.loanDebts.reduce((acc, d) => {
      if (!d.totalDebtUsdt) return acc;
      return acc.plus(fxUsdtKrw ? new Decimal(d.totalDebtUsdt).times(fxUsdtKrw.rate) : new Decimal(0));
    }, new Decimal(0));

    return {
      exchange: e.exchange,
      quoteCurrency: e.quoteCurrency,
      cryptoKrw,
      cashKrw,
      totalKrw: cryptoKrw.plus(cashKrw),
      debtKrw,
      unrealizedKrw,
      realizedKrw,
      holdingsCount: exHoldings.length,
      takenAt: e.takenAt,
    };
  });

  return {
    exchanges, total, manual, exchangeSummaries, holdingRows, cb,
    txCount: txs.length, totalRealized, totalUnrealized, fxUsdtKrw,
    allDebts, exchangeDebtKrw, unpricedDebts, unpriced,
  };
}
