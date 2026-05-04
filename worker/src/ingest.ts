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
//   - currency=KRW 는 cash flow 라 v0.1 에서는 skip (현금 추적 별도)
//   - state 는 'DONE' / 'DEPOSIT_ACCEPTED' 만 (실제 자산 이동 완료)
//   - withdraw 의 fee 는 코인 단위 (network fee). 거래소에서 빠진 총량 = amount + fee.
//     평균단가 계산엔 영향 X (cost-basis 가 deposit/withdraw 별도 로직).
//   - price = 0 (구매가 아님). fee 는 거래소 수수료 컬럼과 의미 다름 → note 에 코인 fee 기록.
function transferToTransaction(
  t: UpbitTransfer | BithumbTransfer,
  exchange: 'upbit' | 'bithumb',
): TransactionInput | null {
  if (t.currency === 'KRW') return null; // cash flow 별도
  // 자산 이동 완료된 것만:
  //   - DONE: 빗썸 출금 / 업비트 출금 / 빗썸 일부 입금
  //   - ACCEPTED: 업비트 입금 (deposit 의 default 종결 상태)
  //   - DEPOSIT_ACCEPTED: 빗썸 staking 보상 입금 등
  const validStates = new Set(['DONE', 'ACCEPTED', 'DEPOSIT_ACCEPTED']);
  if (!validStates.has(t.state)) return null;
  const amount = new Decimal(t.amount ?? '0');
  if (amount.lte(0)) return null;
  const coinFee = new Decimal(t.fee ?? '0');
  // 출금 시 거래소 잔고에서 빠진 총량 = amount + fee (네트워크 수수료)
  const qty = t.type === 'withdraw' ? amount.plus(coinFee) : amount;
  return {
    timestamp: new Date(t.created_at).getTime(),
    source: 'exchange',
    exchange,
    externalId: t.uuid,
    assetClass: 'crypto',
    assetSymbol: t.currency,
    side: t.type === 'deposit' ? 'deposit' : 'withdraw',
    qty: qty.toString(),
    price: '0',
    fee: '0', // KRW fee 가 아니므로 0. 코인 fee 는 qty 에 흡수.
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
    for (const d of [...deposits, ...withdraws]) {
      const t = transferToTransaction(d, source);
      if (t) all.push(t);
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
