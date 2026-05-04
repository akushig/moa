import { Decimal } from 'decimal.js';
import { getUpbitAccounts, getUpbitKrwMarkets } from './exchanges/upbit.js';
import { getBithumbAccounts, getBithumbKrwMarkets } from './exchanges/bithumb.js';
import { getUpbitClosedOrders, type UpbitOrder } from './exchanges/upbit-orders.js';
import { getBithumbClosedOrders, type BithumbOrder } from './exchanges/bithumb-orders.js';
import { upsertTransactions, type TransactionInput } from './db.js';

// 주어진 closed order → Transaction row.
// price = null (시장가 주문) 케이스: executed_volume × ??? 알 수 없으므로 paid_fee
// 기준으로 무시. v0.1 dogfood = 지정가 위주이므로 가벼운 처리.
function orderToTransaction(
  o: UpbitOrder | BithumbOrder,
  exchange: 'upbit' | 'bithumb',
): TransactionInput | null {
  const executed = new Decimal(o.executed_volume ?? '0');
  if (executed.lte(0)) return null;
  // market = "KRW-BTC" → quote = "KRW", base = "BTC"
  const [quote, base] = o.market.split('-');
  if (!quote || !base) return null;

  // price 가 null (시장가 매수의 경우 ord_type=price 면 KRW 금액 명시) — 안전하게 0 처리.
  // 차트 정확도가 실제 trade 평균가가 필요하지만 현재 단순 spec 으로 충분.
  const price = o.price ? new Decimal(o.price).toString() : '0';
  return {
    timestamp: new Date(o.created_at).getTime(),
    source: 'exchange',
    exchange,
    externalId: o.uuid,
    assetClass: 'crypto',
    assetSymbol: base,
    side: o.side === 'bid' ? 'buy' : 'sell',
    qty: executed.toString(),
    price,
    fee: o.paid_fee ?? '0',
    currency: quote, // KRW
    note: `${o.ord_type ?? ''}`.slice(0, 32) || null,
  };
}

export type IngestResult = {
  exchange: 'upbit' | 'bithumb';
  marketsScanned: string[];
  ordersFetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
};

export async function ingestUpbit(): Promise<IngestResult> {
  const errors: string[] = [];
  const accounts = await getUpbitAccounts();
  const krwMarkets = await getUpbitKrwMarkets();
  // 잔고 0 인 코인도 과거에 거래했을 수 있으므로 모든 KRW 마켓을 훑으면 좋지만
  // 비용 ↑ → 일단 현재 보유 + KRW 페어 있는 것만. 잔고 sell 다 한 코인은 v0.5+ 보강.
  const markets = accounts
    .filter((a) => a.currency !== 'KRW')
    .map((a) => `KRW-${a.currency}`)
    .filter((m) => krwMarkets.has(m));

  const all: TransactionInput[] = [];
  let ordersFetched = 0;
  for (const m of markets) {
    try {
      const orders = await getUpbitClosedOrders(m);
      ordersFetched += orders.length;
      for (const o of orders) {
        const t = orderToTransaction(o, 'upbit');
        if (t) all.push(t);
      }
    } catch (e) {
      errors.push(`${m}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const { inserted, skipped } = await upsertTransactions(all);
  return {
    exchange: 'upbit',
    marketsScanned: markets,
    ordersFetched,
    inserted,
    skipped,
    errors,
  };
}

export async function ingestBithumb(): Promise<IngestResult> {
  const errors: string[] = [];
  const accounts = await getBithumbAccounts();
  const krwMarkets = await getBithumbKrwMarkets();
  const markets = accounts
    .filter((a) => a.currency !== 'KRW')
    .map((a) => `KRW-${a.currency}`)
    .filter((m) => krwMarkets.has(m));

  const all: TransactionInput[] = [];
  let ordersFetched = 0;
  for (const m of markets) {
    try {
      const orders = await getBithumbClosedOrders(m);
      ordersFetched += orders.length;
      for (const o of orders) {
        const t = orderToTransaction(o, 'bithumb');
        if (t) all.push(t);
      }
    } catch (e) {
      errors.push(`${m}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const { inserted, skipped } = await upsertTransactions(all);
  return {
    exchange: 'bithumb',
    marketsScanned: markets,
    ordersFetched,
    inserted,
    skipped,
    errors,
  };
}
