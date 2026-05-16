// 코빗 API
// Auth: OAuth2 client_credentials → Bearer token
// 잔고: GET /v1/user/balances
// 체결내역: GET /v1/user/orders?status=filled
// Ticker: GET /v1/ticker/detailed/all

import { Decimal } from 'decimal.js';
import { getUsdKrwRate } from '../fx.js';

const KORBIT_API = 'https://api.korbit.co.kr';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getKorbitToken(): Promise<string> {
  const clientId = process.env.KORBIT_CLIENT_ID;
  const clientSecret = process.env.KORBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('KORBIT_CLIENT_ID / KORBIT_CLIENT_SECRET not set');

  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;

  const res = await fetch(`${KORBIT_API}/v1/oauth2/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`코빗 oauth ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000 - 60_000,
  };
  return tokenCache.token;
}

async function korbitGet<T>(path: string): Promise<T> {
  const token = await getKorbitToken();
  const res = await fetch(`${KORBIT_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`코빗 ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

type KorbitBalances = Record<
  string,
  { available: string; trade_in_use: string; withdrawal_in_use: string }
>;

export type KorbitHolding = {
  currency: string;
  qty: string;
  avgBuyPrice: string;
  unitCurrency: string;
  priceKrw: string | null;
  valueKrw: string | null;
  source: 'krw_market' | 'fx' | 'unpriced';
};

export type KorbitKrwBreakdown = {
  totalKrw: Decimal;
  cashKrw: Decimal;
  cryptoKrw: Decimal;
  unpriced: { currency: string; balance: string }[];
  holdings: KorbitHolding[];
};

type TickerAll = Record<string, { last: string }>;

export async function getKorbitTickers(): Promise<Map<string, number>> {
  const res = await fetch(`${KORBIT_API}/v1/ticker/detailed/all`);
  if (!res.ok) throw new Error(`코빗 ticker ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as TickerAll;
  const map = new Map<string, number>();
  // key = "btc_krw", "eth_krw" etc.
  for (const [pair, v] of Object.entries(json)) {
    if (!pair.endsWith('_krw')) continue;
    const coin = pair.replace('_krw', '').toUpperCase();
    map.set(coin, Number(v.last));
  }
  return map;
}

export async function getKorbitKrwBreakdown(): Promise<KorbitKrwBreakdown> {
  const balances = await korbitGet<KorbitBalances>('/v1/user/balances');

  let cashKrw = new Decimal(0);
  let cryptoKrw = new Decimal(0);
  const unpriced: { currency: string; balance: string }[] = [];
  const holdings: KorbitHolding[] = [];
  const FX_FALLBACK = new Set(['USDT', 'USDC', 'DAI', 'BUSD']);

  const coinAccounts: { currency: string; qty: Decimal }[] = [];
  for (const [cur, bal] of Object.entries(balances)) {
    const qty = new Decimal(bal.available).plus(bal.trade_in_use).plus(bal.withdrawal_in_use);
    if (qty.lte(0)) continue;
    if (cur.toLowerCase() === 'krw') {
      cashKrw = cashKrw.plus(qty);
      continue;
    }
    coinAccounts.push({ currency: cur.toUpperCase(), qty });
  }

  if (coinAccounts.length === 0) {
    return { totalKrw: cashKrw, cashKrw, cryptoKrw, unpriced, holdings };
  }

  const priceMap = await getKorbitTickers();

  let usdKrw: Decimal | null = null;
  for (const a of coinAccounts) {
    const price = priceMap.get(a.currency);
    if (price !== undefined && price > 0) {
      const value = a.qty.times(price);
      cryptoKrw = cryptoKrw.plus(value);
      holdings.push({
        currency: a.currency,
        qty: a.qty.toString(),
        avgBuyPrice: '0',
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
          avgBuyPrice: '0',
          unitCurrency: 'KRW',
          priceKrw: usdKrw.toString(),
          valueKrw: value.toString(),
          source: 'fx',
        });
      } else {
        unpriced.push({ currency: a.currency, balance: a.qty.toString() });
        holdings.push({ currency: a.currency, qty: a.qty.toString(), avgBuyPrice: '0', unitCurrency: 'KRW', priceKrw: null, valueKrw: null, source: 'unpriced' });
      }
    } else {
      unpriced.push({ currency: a.currency, balance: a.qty.toString() });
      holdings.push({ currency: a.currency, qty: a.qty.toString(), avgBuyPrice: '0', unitCurrency: 'KRW', priceKrw: null, valueKrw: null, source: 'unpriced' });
    }
  }

  return { totalKrw: cashKrw.plus(cryptoKrw), cashKrw, cryptoKrw, unpriced, holdings };
}

// 체결내역 — Transaction insert 용
export type KorbitOrder = {
  id: string;
  currency_pair: string; // btc_krw
  side: 'bid' | 'ask'; // bid=매수, ask=매도
  avg_price: string;
  filled_amount: string;
  fee: string;
  created_at: string; // epoch ms
};

export async function getKorbitFilledOrders(
  currencyPair: string,
): Promise<KorbitOrder[]> {
  const orders: KorbitOrder[] = [];
  let offset = 0;
  const limit = 40;
  for (let page = 0; page < 100; page++) {
    const json = await korbitGet<KorbitOrder[]>(
      `/v1/user/orders?currency_pair=${currencyPair}&status=filled&limit=${limit}&offset=${offset}`,
    );
    orders.push(...json);
    if (json.length < limit) break;
    offset += limit;
  }
  return orders;
}
