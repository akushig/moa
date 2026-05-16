// 코인원 API v2.1
// Auth: HMAC-SHA256 — X-COINONE-PAYLOAD (base64 JSON) + X-COINONE-SIGNATURE
// 잔고: POST /v2.1/account/balance/all
// 체결내역: GET /v2.1/order/complete_orders (market, page, size)
// Ticker: GET /public/v2/ticker_new/KRW

import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import { getUsdKrwRate } from '../fx.js';

const COINONE_API = 'https://api.coinone.co.kr';

function signCoinone(
  accessToken: string,
  secretKey: string,
  body: Record<string, unknown>,
): { payload: string; signature: string } {
  const fullBody = {
    ...body,
    access_token: accessToken,
    nonce: Date.now(),
  };
  const payload = Buffer.from(JSON.stringify(fullBody)).toString('base64');
  const signature = crypto
    .createHmac('sha256', secretKey.toUpperCase())
    .update(payload)
    .digest('hex');
  return { payload, signature };
}

async function coinonePrivate<T>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const accessToken = process.env.COINONE_ACCESS_TOKEN;
  const secretKey = process.env.COINONE_SECRET_KEY;
  if (!accessToken || !secretKey) throw new Error('COINONE_ACCESS_TOKEN / COINONE_SECRET_KEY not set');

  const { payload, signature } = signCoinone(accessToken, secretKey, body);
  const res = await fetch(`${COINONE_API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-COINONE-PAYLOAD': payload,
      'X-COINONE-SIGNATURE': signature,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`코인원 ${path} ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result: string; errorCode: string } & T;
  if (json.result !== 'success' && json.errorCode !== '0') {
    throw new Error(`코인원 ${path} error: ${json.errorCode} ${json.result}`);
  }
  return json;
}

export type CoinoneTicker = { target_currency: string; last: string };

export async function getCoinoneTickers(): Promise<Map<string, number>> {
  const res = await fetch(`${COINONE_API}/public/v2/ticker_new/KRW`);
  if (!res.ok) throw new Error(`코인원 ticker ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { tickers: CoinoneTicker[] };
  const map = new Map<string, number>();
  for (const t of json.tickers ?? []) {
    map.set(t.target_currency.toUpperCase(), Number(t.last));
  }
  return map;
}

export type CoinoneHolding = {
  currency: string;
  qty: string;
  avgBuyPrice: string;
  unitCurrency: string;
  priceKrw: string | null;
  valueKrw: string | null;
  source: 'krw_market' | 'fx' | 'unpriced';
};

export type CoinoneKrwBreakdown = {
  totalKrw: Decimal;
  cashKrw: Decimal;
  cryptoKrw: Decimal;
  unpriced: { currency: string; balance: string }[];
  holdings: CoinoneHolding[];
};

type BalanceResponse = {
  balances: {
    currency: string;
    available: string;
    limit: string; // locked
    average_price?: string;
  }[];
};

export async function getCoinoneKrwBreakdown(): Promise<CoinoneKrwBreakdown> {
  const balRes = await coinonePrivate<BalanceResponse>('/v2.1/account/balance/all');
  const balances = balRes.balances ?? [];

  let cashKrw = new Decimal(0);
  let cryptoKrw = new Decimal(0);
  const unpriced: { currency: string; balance: string }[] = [];
  const holdings: CoinoneHolding[] = [];
  const FX_FALLBACK = new Set(['USDT', 'USDC', 'DAI', 'BUSD']);

  const coinAccounts: { currency: string; qty: Decimal; avgPrice: string }[] = [];
  for (const b of balances) {
    const qty = new Decimal(b.available).plus(b.limit);
    if (qty.lte(0)) continue;
    if (b.currency.toUpperCase() === 'KRW') {
      cashKrw = cashKrw.plus(qty);
      continue;
    }
    coinAccounts.push({
      currency: b.currency.toUpperCase(),
      qty,
      avgPrice: b.average_price ?? '0',
    });
  }

  if (coinAccounts.length === 0) {
    return { totalKrw: cashKrw, cashKrw, cryptoKrw, unpriced, holdings };
  }

  const priceMap = await getCoinoneTickers();

  let usdKrw: Decimal | null = null;
  for (const a of coinAccounts) {
    const price = priceMap.get(a.currency);
    if (price !== undefined && price > 0) {
      const value = a.qty.times(price);
      cryptoKrw = cryptoKrw.plus(value);
      holdings.push({
        currency: a.currency,
        qty: a.qty.toString(),
        avgBuyPrice: a.avgPrice,
        unitCurrency: 'KRW',
        priceKrw: new Decimal(price).toString(),
        valueKrw: value.toString(),
        source: 'krw_market',
      });
    } else if (FX_FALLBACK.has(a.currency)) {
      if (usdKrw === null) {
        try { usdKrw = new Decimal(await getUsdKrwRate()); } catch { usdKrw = null; }
      }
      if (usdKrw) {
        const value = a.qty.times(usdKrw);
        cryptoKrw = cryptoKrw.plus(value);
        holdings.push({
          currency: a.currency,
          qty: a.qty.toString(),
          avgBuyPrice: a.avgPrice,
          unitCurrency: 'KRW',
          priceKrw: usdKrw.toString(),
          valueKrw: value.toString(),
          source: 'fx',
        });
      } else {
        unpriced.push({ currency: a.currency, balance: a.qty.toString() });
        holdings.push({ currency: a.currency, qty: a.qty.toString(), avgBuyPrice: a.avgPrice, unitCurrency: 'KRW', priceKrw: null, valueKrw: null, source: 'unpriced' });
      }
    } else {
      unpriced.push({ currency: a.currency, balance: a.qty.toString() });
      holdings.push({ currency: a.currency, qty: a.qty.toString(), avgBuyPrice: a.avgPrice, unitCurrency: 'KRW', priceKrw: null, valueKrw: null, source: 'unpriced' });
    }
  }

  return { totalKrw: cashKrw.plus(cryptoKrw), cashKrw, cryptoKrw, unpriced, holdings };
}

// 체결내역 — Transaction 테이블 insert 용 raw 반환
export type CoinoneOrder = {
  timestamp: string; // epoch ms
  order_id: string;
  target_currency: string; // BTC
  is_ask: boolean; // true=매도, false=매수
  qty: string;
  price: string;
  fee: string;
  fee_currency: string;
};

export async function getCoinoneCompleteOrders(
  currency: string,
): Promise<CoinoneOrder[]> {
  const orders: CoinoneOrder[] = [];
  // 코인원 v2.1 paginated: page 0-based
  for (let page = 0; page < 100; page++) {
    const res = await coinonePrivate<{ complete_orders: CoinoneOrder[] }>(
      '/v2.1/order/complete_orders',
      { target_currency: currency, page, size: 100 },
    );
    const batch = res.complete_orders ?? [];
    orders.push(...batch);
    if (batch.length < 100) break;
  }
  return orders;
}
