import { Decimal } from 'decimal.js';
import { getUpbitAccounts, getUpbitKrwMarkets } from './exchanges/upbit.js';
import { getBithumbAccounts, getBithumbKrwMarkets } from './exchanges/bithumb.js';
import { getUpbitClosedOrders, type UpbitOrder } from './exchanges/upbit-orders.js';
import { getBithumbClosedOrders, type BithumbOrder } from './exchanges/bithumb-orders.js';
import {
  upsertTransactions,
  getLatestOrderTimestamp,
  type TransactionInput,
} from './db.js';

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
  marketsBackfill: string[]; // 첫 ingest (since=null) 라 backward walk 한 마켓
  ordersFetched: number;
  inserted: number;
  skipped: number;
  errors: string[];
};

async function ingest(
  source: 'upbit' | 'bithumb',
  fetchMarkets: () => Promise<string[]>,
  fetchOrders: (market: string, since?: number) => Promise<UpbitOrder[] | BithumbOrder[]>,
): Promise<IngestResult> {
  const errors: string[] = [];
  const markets = await fetchMarkets();
  const marketsBackfill: string[] = [];

  const all: TransactionInput[] = [];
  let ordersFetched = 0;
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
  const { inserted, skipped } = await upsertTransactions(all);
  return {
    exchange: source,
    marketsScanned: markets,
    marketsBackfill,
    ordersFetched,
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
      // 잔고 0 인 코인은 v0.5+ 에서 별도 처리. 일단 현재 보유 + KRW 마켓만.
      return accounts
        .filter((a) => a.currency !== 'KRW')
        .map((a) => `KRW-${a.currency}`)
        .filter((m) => krwMarkets.has(m));
    },
    getUpbitClosedOrders,
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
  );
}
