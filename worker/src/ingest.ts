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

// closed order → Transaction row.
// per-unit price = executed_funds / executed_volume (모든 ord_type 에서 정확).
// `price` 필드는 ord_type 마다 의미 다름 (limit=지정가, price=KRW주문금액,
// market=null) → 절대 직접 사용 X.
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
