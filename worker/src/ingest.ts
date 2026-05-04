import { Decimal } from 'decimal.js';
import { getUpbitAccounts, getUpbitKrwMarkets } from './exchanges/upbit.js';
import { getBithumbAccounts, getBithumbKrwMarkets } from './exchanges/bithumb.js';
import { getUpbitClosedOrders, type UpbitOrder } from './exchanges/upbit-orders.js';
import { getBithumbClosedOrders, type BithumbOrder } from './exchanges/bithumb-orders.js';
import {
  getUpbitDeposits,
  getUpbitWithdraws,
  type UpbitTransfer,
} from './exchanges/upbit-transfers.js';
import {
  getBithumbDeposits,
  getBithumbWithdraws,
  type BithumbTransfer,
} from './exchanges/bithumb-transfers.js';
import {
  upsertTransactions,
  getLatestOrderTimestamp,
  getLatestTransferTimestamp,
  type TransactionInput,
} from './db.js';
import { getHistoricalPriceAt } from './historical-prices.js';

// closed order → Transaction row.
// per-unit price = executed_funds / executed_volume (모든 ord_type 에서 정확).
function orderToTransaction(
  o: UpbitOrder | BithumbOrder,
  exchange: 'upbit' | 'bithumb',
): TransactionInput | null {
  const executed = new Decimal(o.executed_volume ?? '0');
  if (executed.lte(0)) return null;
  const funds = new Decimal(o.executed_funds ?? '0');
  if (funds.lte(0)) return null;
  const [quote, base] = o.market.split('-');
  if (!quote || !base) return null;

  const perUnit = funds.div(executed);
  return {
    timestamp: new Date(o.created_at).getTime(),
    source: 'exchange',
    exchange,
    externalId: o.uuid,
    assetClass: 'crypto',
    assetSymbol: base,
    side: o.side === 'bid' ? 'buy' : 'sell',
    qty: executed.toString(),
    price: perUnit.toString(),
    fee: o.paid_fee ?? '0',
    currency: quote,
    note: `${o.ord_type ?? ''}`.slice(0, 32) || null,
  };
}

// deposit/withdraw → Transaction row.
//   - currency=KRW 는 cash flow 라 v0.1 에서는 skip
//   - state: DONE / ACCEPTED / DEPOSIT_ACCEPTED 만 (자산 이동 완료)
//   - withdraw qty = amount + network fee (거래소 잔고에서 빠진 총량). price=0.
//     cost-basis 는 비례 차감하므로 price 무관.
//   - deposit price = 그 시점 일봉 종가 (해당 거래소 KRW-XXX). 못 가져오면 0.
//     cost-basis 가 price>0 일 때만 buy 처럼 cost 가산 → 거래소 staking 보상
//     fair-value 정의와 일치해서 평균단가 매칭됨.
async function transferToTransaction(
  t: UpbitTransfer | BithumbTransfer,
  exchange: 'upbit' | 'bithumb',
): Promise<TransactionInput | null> {
  if (t.currency === 'KRW') return null;
  const validStates = new Set(['DONE', 'ACCEPTED', 'DEPOSIT_ACCEPTED']);
  if (!validStates.has(t.state)) return null;
  const amount = new Decimal(t.amount ?? '0');
  if (amount.lte(0)) return null;
  const coinFee = new Decimal(t.fee ?? '0');
  const qty = t.type === 'withdraw' ? amount.plus(coinFee) : amount;
  const ts = new Date(t.created_at).getTime();

  let price = '0';
  if (t.type === 'deposit') {
    const market = `KRW-${t.currency}`;
    const histPrice = await getHistoricalPriceAt(exchange, market, ts);
    if (histPrice) price = histPrice;
    // null 이면 그대로 0 → cost-basis 측에서 trackedQty 변경 없이 skip 됨
  }

  return {
    timestamp: ts,
    source: 'exchange',
    exchange,
    externalId: t.uuid,
    assetClass: 'crypto',
    assetSymbol: t.currency,
    side: t.type === 'deposit' ? 'deposit' : 'withdraw',
    qty: qty.toString(),
    price,
    fee: '0',
    currency: t.currency,
    note: `${t.type} ${t.net_type ?? ''}`.slice(0, 32) || null,
  };
}

export type IngestResult = {
  exchange: 'upbit' | 'bithumb';
  marketsScanned: string[];
  marketsBackfill: string[];
  ordersFetched: number;
  transfersFetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
};

async function ingest(
  source: 'upbit' | 'bithumb',
  fetchMarkets: () => Promise<string[]>,
  fetchOrders: (market: string, since?: number) => Promise<UpbitOrder[] | BithumbOrder[]>,
  fetchDeposits: (since?: number) => Promise<UpbitTransfer[] | BithumbTransfer[]>,
  fetchWithdraws: (since?: number) => Promise<UpbitTransfer[] | BithumbTransfer[]>,
): Promise<IngestResult> {
  const errors: string[] = [];
  const markets = await fetchMarkets();
  const marketsBackfill: string[] = [];

  const all: TransactionInput[] = [];
  let ordersFetched = 0;
  let transfersFetched = 0;

  // 1) orders — 마켓별 incremental
  for (const m of markets) {
    const base = m.slice('KRW-'.length);
    try {
      const since = await getLatestOrderTimestamp(source, base);
      if (since === null) marketsBackfill.push(m);
      const orders = await fetchOrders(m, since ?? undefined);
      ordersFetched += orders.length;
      for (const o of orders) {
        const t = orderToTransaction(o, source);
        if (t) all.push(t);
      }
    } catch (e) {
      errors.push(`${m}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2) deposits + withdraws — 거래소 단위 (currency 통합 endpoint)
  try {
    const since = await getLatestTransferTimestamp(source);
    const [deposits, withdraws] = await Promise.all([
      fetchDeposits(since ?? undefined),
      fetchWithdraws(since ?? undefined),
    ]);
    transfersFetched = deposits.length + withdraws.length;
    // deposit 마다 historical price API 호출 — 직렬 처리 시 100+건 누적되어 느림.
    // 동시성 10 으로 chunk 처리. (1m candle endpoint rate limit 충분히 여유, fetch 자체는 5s timeout.)
    const allTransfers = [...deposits, ...withdraws];
    const CHUNK = 10;
    for (let i = 0; i < allTransfers.length; i += CHUNK) {
      const chunk = allTransfers.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map((d) => transferToTransaction(d, source)));
      for (const t of results) if (t) all.push(t);
    }
  } catch (e) {
    errors.push(`transfers: ${e instanceof Error ? e.message : String(e)}`);
  }

  const { inserted, skipped } = await upsertTransactions(all);
  return {
    exchange: source,
    marketsScanned: markets,
    marketsBackfill,
    ordersFetched,
    transfersFetched,
    inserted,
    skipped,
    errors,
  };
}

export async function ingestUpbit(): Promise<IngestResult> {
  return ingest(
    'upbit',
    async () => {
      const accounts = await getUpbitAccounts();
      const krwMarkets = await getUpbitKrwMarkets();
      return accounts
        .filter((a) => a.currency !== 'KRW')
        .map((a) => `KRW-${a.currency}`)
        .filter((m) => krwMarkets.has(m));
    },
    getUpbitClosedOrders,
    getUpbitDeposits,
    getUpbitWithdraws,
  );
}

export async function ingestBithumb(): Promise<IngestResult> {
  return ingest(
    'bithumb',
    async () => {
      const accounts = await getBithumbAccounts();
      const krwMarkets = await getBithumbKrwMarkets();
      return accounts
        .filter((a) => a.currency !== 'KRW')
        .map((a) => `KRW-${a.currency}`)
        .filter((m) => krwMarkets.has(m));
    },
    getBithumbClosedOrders,
    getBithumbDeposits,
    getBithumbWithdraws,
  );
}
