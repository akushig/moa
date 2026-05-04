// Binance Phase 2 — myTrades + deposits/withdraws → Transaction.
// Vercel function (icn1) 에서 직접 호출. 워커는 upbit/bithumb 만 담당.
//
// myTrades: 잔고 nonZero 코인의 USDT 페어 마다 1회 (concurrency 4).
// 잔고 보유 안 해도 과거 거래 있으면 잡고 싶지만 Binance API 가 symbol 필수라
// v0.1 에서는 현재 잔고 기준 (qty>0). 매도 청산된 코인은 다음 sync 시 잔고
// 줄어든 시점에서 fetch 한 번 시도하고 stop. 이 정책은 cost-basis 가 0 으로
// 수렴하는 결과는 같으므로 OK.
import { Decimal } from '@/lib/decimal';
import { prisma } from '@/lib/db';
import { binanceAuthFetch, BINANCE_API } from './binance-auth';
import { getBinanceMyTrades, type BinanceTrade } from './binance-trades';
import {
  getBinanceDeposits,
  getBinanceWithdraws,
  type BinanceDeposit,
  type BinanceWithdraw,
} from './binance-transfers';
import { getBinanceDividends, type BinanceDividend } from './binance-rewards';
import { getAllWalletPositions } from './binance-wallets';
import { getHistoricalPriceAt } from '@/lib/calc/historical-price';

const USDT_PARITY = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI']);

type TxRow = {
  timestamp: Date;
  source: 'exchange';
  exchange: 'binance';
  externalId: string;
  assetClass: 'crypto';
  assetSymbol: string;
  side: 'buy' | 'sell' | 'deposit' | 'withdraw';
  qty: string;
  price: string;
  fee: string;
  currency: string;
  note: string | null;
};

// 가장 최근 timestamp 의 trade 의 externalId+1 → fromId. id 는 단조증가 ascending.
async function getNextTradeId(symbol: string): Promise<number> {
  const r = await prisma.transaction.findFirst({
    where: {
      source: 'exchange',
      exchange: 'binance',
      assetSymbol: symbol,
      side: { in: ['buy', 'sell'] },
    },
    orderBy: { timestamp: 'desc' },
    select: { externalId: true },
  });
  if (!r?.externalId) return 0;
  const n = Number(r.externalId);
  return Number.isFinite(n) && n >= 0 ? n + 1 : 0;
}

async function getLatestTransferTs(): Promise<number | null> {
  // dividend 도 'deposit' side 로 적재되어 같이 조회됨. since 기반 incremental 시
  // dividend/transfer 한쪽이 더 최근이어도 다른쪽 walk window 가 1h overlap 으로 cover.
  const r = await prisma.transaction.findFirst({
    where: {
      source: 'exchange',
      exchange: 'binance',
      side: { in: ['deposit', 'withdraw'] },
    },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
  return r ? r.timestamp.getTime() : null;
}

function tradeToTx(t: BinanceTrade, base: string, quote: string): TxRow | null {
  const qty = new Decimal(t.qty);
  const quoteQty = new Decimal(t.quoteQty);
  if (qty.lte(0) || quoteQty.lte(0)) return null;
  const perUnit = quoteQty.div(qty);
  // commissionAsset 이 quote (USDT) 일 때만 fee 기록 → cost-basis 의 fee 단위와 정합.
  // base 단위 fee (받는 코인) 나 BNB 할인은 v0.1 에서 무시 (~0.075% impact).
  const fee = t.commissionAsset === quote ? new Decimal(t.commission) : new Decimal(0);
  return {
    timestamp: new Date(t.time),
    source: 'exchange',
    exchange: 'binance',
    externalId: String(t.id),
    assetClass: 'crypto',
    assetSymbol: base,
    side: t.isBuyer ? 'buy' : 'sell',
    qty: qty.toString(),
    price: perUnit.toString(),
    fee: fee.toString(),
    currency: quote,
    note: t.isMaker ? 'maker' : 'taker',
  };
}

async function depositToTx(d: BinanceDeposit): Promise<TxRow | null> {
  const amount = new Decimal(d.amount);
  if (amount.lte(0)) return null;
  if (USDT_PARITY.has(d.coin)) {
    return {
      timestamp: new Date(d.insertTime),
      source: 'exchange',
      exchange: 'binance',
      externalId: `dep:${d.id}`,
      assetClass: 'crypto',
      assetSymbol: d.coin,
      side: 'deposit',
      qty: amount.toString(),
      price: '1',
      fee: '0',
      currency: 'USDT',
      note: `deposit ${d.network ?? ''}`.slice(0, 32) || null,
    };
  }
  let price = '0';
  const market = `USDT-${d.coin}`;
  const histPrice = await getHistoricalPriceAt('binance', market, d.insertTime);
  if (histPrice) price = histPrice.toString();
  return {
    timestamp: new Date(d.insertTime),
    source: 'exchange',
    exchange: 'binance',
    externalId: `dep:${d.id}`,
    assetClass: 'crypto',
    assetSymbol: d.coin,
    side: 'deposit',
    qty: amount.toString(),
    price,
    fee: '0',
    currency: 'USDT',
    note: `deposit ${d.network ?? ''}`.slice(0, 32) || null,
  };
}

async function dividendToTx(d: BinanceDividend): Promise<TxRow | null> {
  const amount = new Decimal(d.amount);
  if (amount.lte(0)) return null;
  const note = (d.enInfo ?? '').slice(0, 32) || null;
  if (USDT_PARITY.has(d.asset)) {
    return {
      timestamp: new Date(d.divTime),
      source: 'exchange',
      exchange: 'binance',
      externalId: `div:${d.id}`,
      assetClass: 'crypto',
      assetSymbol: d.asset,
      side: 'deposit',
      qty: amount.toString(),
      price: '1',
      fee: '0',
      currency: 'USDT',
      note,
    };
  }
  let price = '0';
  const histPrice = await getHistoricalPriceAt('binance', `USDT-${d.asset}`, d.divTime);
  if (histPrice) price = histPrice.toString();
  return {
    timestamp: new Date(d.divTime),
    source: 'exchange',
    exchange: 'binance',
    externalId: `div:${d.id}`,
    assetClass: 'crypto',
    assetSymbol: d.asset,
    side: 'deposit',
    qty: amount.toString(),
    price,
    fee: '0',
    currency: 'USDT',
    note,
  };
}

function withdrawToTx(w: BinanceWithdraw): TxRow | null {
  const amount = new Decimal(w.amount);
  if (amount.lte(0)) return null;
  const fee = new Decimal(w.transactionFee ?? '0');
  const qty = amount.plus(fee); // 거래소 잔고에서 빠진 총량
  // applyTime: 'YYYY-MM-DD HH:MM:SS' UTC. completeTime 있으면 우선.
  const raw = (w.completeTime ?? w.applyTime).replace(' ', 'T') + 'Z';
  const ts = new Date(raw).getTime();
  if (!Number.isFinite(ts)) return null;
  return {
    timestamp: new Date(ts),
    source: 'exchange',
    exchange: 'binance',
    externalId: `wd:${w.id}`,
    assetClass: 'crypto',
    assetSymbol: w.coin,
    side: 'withdraw',
    qty: qty.toString(),
    price: '0',
    fee: '0',
    currency: 'USDT',
    note: `withdraw ${w.network ?? ''}`.slice(0, 32) || null,
  };
}

export type BinanceIngestResult = {
  exchange: 'binance';
  symbolsScanned: string[];
  tradesFetched: number;
  transfersFetched: number;
  dividendsFetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
};

export async function ingestBinance(): Promise<BinanceIngestResult> {
  const errors: string[] = [];
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
    return {
      exchange: 'binance',
      symbolsScanned: [],
      tradesFetched: 0,
      transfersFetched: 0,
      dividendsFetched: 0,
      inserted: 0,
      skipped: 0,
      errors: ['BINANCE_API_KEY/SECRET not set'],
    };
  }

  // 1) spot 잔고 + Earn/Funding/Loan-collateral wallet positions + tradable USDT 페어.
  // earn/funding 에 들어있는 코인도 myTrades 대상에 포함시켜야 cost-basis 가 맞음.
  let symbolsScanned: { base: string; symbol: string }[] = [];
  try {
    const [acctRes, exInfoRes, walletResult] = await Promise.all([
      binanceAuthFetch('/api/v3/account'),
      fetch(`${BINANCE_API}/api/v3/exchangeInfo?permissions=SPOT`, { cache: 'no-store' }),
      getAllWalletPositions(),
    ]);
    if (!acctRes.ok) {
      throw new Error(`Binance /api/v3/account ${acctRes.status}: ${await acctRes.text()}`);
    }
    if (!exInfoRes.ok) throw new Error(`Binance exchangeInfo ${exInfoRes.status}`);
    const acct = (await acctRes.json()) as {
      balances: { asset: string; free: string; locked: string }[];
    };
    const exInfo = (await exInfoRes.json()) as {
      symbols: { symbol: string; status: string; baseAsset: string; quoteAsset: string }[];
    };
    const tradable = new Set(
      exInfo.symbols.filter((s) => s.status === 'TRADING').map((s) => s.symbol),
    );

    const assets = new Set<string>();
    for (const b of acct.balances ?? []) {
      if (new Decimal(b.free).plus(b.locked).gt(0)) assets.add(b.asset);
    }
    for (const p of walletResult.positions) {
      if (p.qty.gt(0)) assets.add(p.asset);
    }
    for (const a of assets) {
      if (USDT_PARITY.has(a)) continue;
      const sym = `${a}USDT`;
      if (tradable.has(sym)) symbolsScanned.push({ base: a, symbol: sym });
    }
    if (walletResult.errors.length > 0) {
      errors.push(...walletResult.errors.map((e) => `wallet: ${e}`));
    }
  } catch (e) {
    errors.push(`balances/exchangeInfo: ${e instanceof Error ? e.message : String(e)}`);
    return {
      exchange: 'binance',
      symbolsScanned: [],
      tradesFetched: 0,
      transfersFetched: 0,
      dividendsFetched: 0,
      inserted: 0,
      skipped: 0,
      errors,
    };
  }

  const all: TxRow[] = [];
  let tradesFetched = 0;
  let transfersFetched = 0;
  let dividendsFetched = 0;

  // 2) trades — concurrency 4 (10s timeout 안에서 18 코인 ~3-5s)
  const CHUNK = 4;
  for (let i = 0; i < symbolsScanned.length; i += CHUNK) {
    const chunk = symbolsScanned.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async ({ base, symbol }) => {
        try {
          const fromId = await getNextTradeId(base);
          const trades = await getBinanceMyTrades(symbol, fromId);
          return { base, symbol, trades };
        } catch (e) {
          errors.push(`${symbol}: ${e instanceof Error ? e.message : String(e)}`);
          return { base, symbol, trades: [] as BinanceTrade[] };
        }
      }),
    );
    for (const { base, trades } of results) {
      tradesFetched += trades.length;
      for (const t of trades) {
        const tx = tradeToTx(t, base, 'USDT');
        if (tx) all.push(tx);
      }
    }
  }

  // 3) deposits + withdraws + dividends (거래소 단위 incremental).
  //    dividend = 스테이킹 보상 / 에어드랍 / Launchpool — deposit/hisrec 에 없는
  //    internal 분배 → assetDividend 로 별도 fetch 후 'deposit' (fair-value cost) 적재.
  try {
    const since = await getLatestTransferTs();
    const [deposits, withdraws, dividends] = await Promise.all([
      getBinanceDeposits(since ?? undefined),
      getBinanceWithdraws(since ?? undefined),
      getBinanceDividends(since ?? undefined),
    ]);
    transfersFetched = deposits.length + withdraws.length;
    dividendsFetched = dividends.length;

    // deposit + dividend 마다 historical USDT-XYZ kline. concurrency 8.
    const PRICE_CHUNK = 8;
    for (let i = 0; i < deposits.length; i += PRICE_CHUNK) {
      const chunk = deposits.slice(i, i + PRICE_CHUNK);
      const results = await Promise.all(chunk.map((d) => depositToTx(d)));
      for (const tx of results) if (tx) all.push(tx);
    }
    for (let i = 0; i < dividends.length; i += PRICE_CHUNK) {
      const chunk = dividends.slice(i, i + PRICE_CHUNK);
      const results = await Promise.all(chunk.map((d) => dividendToTx(d)));
      for (const tx of results) if (tx) all.push(tx);
    }

    for (const w of withdraws) {
      const tx = withdrawToTx(w);
      if (tx) all.push(tx);
    }
  } catch (e) {
    errors.push(`transfers: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4) per-row upsert. SQLite/libsql adapter 가 createMany.skipDuplicates 미지원 →
  // P2002 (UNIQUE conflict) catch 로 idempotent 보장. (source, exchange, externalId).
  let inserted = 0;
  let skipped = 0;
  for (const t of all) {
    try {
      await prisma.transaction.create({ data: t });
      inserted += 1;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2002') {
        skipped += 1;
      } else {
        errors.push(`upsert ${t.assetSymbol}/${t.externalId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return {
    exchange: 'binance',
    symbolsScanned: symbolsScanned.map((s) => s.symbol),
    tradesFetched,
    transfersFetched,
    dividendsFetched,
    inserted,
    skipped,
    errors,
  };
}
