import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import { getUsdKrwRate } from '../fx.js';

// 빗썸 v2 API:
//   - JWT Bearer auth (HS256), Authorization 헤더
//   - payload = { access_key, nonce: uuid, timestamp: epoch ms, [query_hash, query_hash_alg] }
//   - 잔고 조회: GET /v1/accounts (업비트 호환 응답)
//   - ticker: GET /v1/ticker?markets=KRW-BTC,KRW-ETH (업비트 호환)
const BITHUMB_API = 'https://api.bithumb.com';

export type BithumbAccount = {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  avg_buy_price_modified?: boolean;
  unit_currency: string;
};

export type BithumbTicker = {
  market: string;
  trade_price: number;
};

export async function signBithumbJWT(
  accessKey: string,
  secretKey: string,
  query?: Record<string, string>,
): Promise<string> {
  const payload: Record<string, unknown> = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
  };
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    payload.query_hash = crypto.createHash('sha512').update(qs).digest('hex');
    payload.query_hash_alg = 'SHA512';
  }
  const secret = new TextEncoder().encode(secretKey);
  return await new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).sign(secret);
}

export async function getBithumbAccounts(): Promise<BithumbAccount[]> {
  const accessKey = process.env.BITHUMB_ACCESS_KEY;
  const secretKey = process.env.BITHUMB_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('BITHUMB_ACCESS_KEY / BITHUMB_SECRET_KEY not set');
  const jwt = await signBithumbJWT(accessKey, secretKey);
  const res = await fetch(`${BITHUMB_API}/v1/accounts`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`빗썸 API ${res.status}: ${await res.text()}`);
  return (await res.json()) as BithumbAccount[];
}

export async function getBithumbTickers(markets: string[]): Promise<BithumbTicker[]> {
  if (markets.length === 0) return [];
  const url = `${BITHUMB_API}/v1/ticker?markets=${markets.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`빗썸 ticker ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as unknown;
  // 빗썸은 invalid market 시 HTTP 200 + { error: { ... } } 반환 → array 가 아니면 throw
  if (!Array.isArray(j)) {
    throw new Error(`빗썸 ticker non-array response: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j as BithumbTicker[];
}

// 빗썸 v2 도 업비트와 동일하게 /v1/market/all 지원. 잔고에 있는 코인이
// KRW 마켓에 없으면 ticker 호출 자체가 invalid → 미리 거른다.
export async function getBithumbKrwMarkets(): Promise<Set<string>> {
  const res = await fetch(`${BITHUMB_API}/v1/market/all`);
  if (!res.ok) throw new Error(`빗썸 market/all ${res.status}: ${await res.text()}`);
  const arr = (await res.json()) as { market: string }[];
  return new Set(arr.filter((m) => m.market.startsWith('KRW-')).map((m) => m.market));
}

const FX_FALLBACK_TO_USD = new Set(['USDT', 'USDC', 'DAI', 'BUSD']);

export type BithumbHolding = {
  currency: string;
  qty: string;
  avgBuyPrice: string;
  unitCurrency: string;
  priceKrw: string | null;
  valueKrw: string | null;
  source: 'krw_market' | 'fx' | 'unpriced';
};

export type BithumbKrwBreakdown = {
  totalKrw: Decimal;
  cashKrw: Decimal;
  cryptoKrw: Decimal;
  unpriced: { currency: string; balance: string }[];
  holdings: BithumbHolding[];
};

export async function getBithumbKrwBreakdown(): Promise<BithumbKrwBreakdown> {
  const accounts = await getBithumbAccounts();
  const nonZero = accounts.filter((a) => new Decimal(a.balance).plus(a.locked).gt(0));

  let cashKrw = new Decimal(0);
  let cryptoKrw = new Decimal(0);
  const unpriced: { currency: string; balance: string }[] = [];
  const holdings: BithumbHolding[] = [];

  const coinAccounts: BithumbAccount[] = [];
  for (const a of nonZero) {
    if (a.currency === 'KRW') {
      cashKrw = cashKrw.plus(a.balance).plus(a.locked);
      continue;
    }
    coinAccounts.push(a);
  }

  if (coinAccounts.length === 0) {
    return { totalKrw: cashKrw, cashKrw, cryptoKrw, unpriced, holdings };
  }

  const krwMarkets = await getBithumbKrwMarkets();
  const tradable = coinAccounts.filter((a) => krwMarkets.has(`KRW-${a.currency}`));
  const untradable = coinAccounts.filter((a) => !krwMarkets.has(`KRW-${a.currency}`));

  const priceMap = new Map<string, number>();
  if (tradable.length > 0) {
    const tickers = await getBithumbTickers(tradable.map((a) => `KRW-${a.currency}`));
    for (const t of tickers) priceMap.set(t.market, t.trade_price);
  }

  for (const a of tradable) {
    const qty = new Decimal(a.balance).plus(a.locked);
    const price = priceMap.get(`KRW-${a.currency}`);
    if (price === undefined) {
      unpriced.push({ currency: a.currency, balance: qty.toString() });
      holdings.push({
        currency: a.currency,
        qty: qty.toString(),
        avgBuyPrice: a.avg_buy_price,
        unitCurrency: a.unit_currency,
        priceKrw: null,
        valueKrw: null,
        source: 'unpriced',
      });
      continue;
    }
    const value = qty.times(price);
    cryptoKrw = cryptoKrw.plus(value);
    holdings.push({
      currency: a.currency,
      qty: qty.toString(),
      avgBuyPrice: a.avg_buy_price,
      unitCurrency: a.unit_currency,
      priceKrw: new Decimal(price).toString(),
      valueKrw: value.toString(),
      source: 'krw_market',
    });
  }

  let usdKrw: Decimal | null = null;
  for (const a of untradable) {
    const qty = new Decimal(a.balance).plus(a.locked);
    if (FX_FALLBACK_TO_USD.has(a.currency)) {
      if (usdKrw === null) {
        try {
          usdKrw = new Decimal(await getUsdKrwRate());
        } catch {
          usdKrw = null;
        }
      }
      if (usdKrw !== null) {
        const value = qty.times(usdKrw);
        cryptoKrw = cryptoKrw.plus(value);
        holdings.push({
          currency: a.currency,
          qty: qty.toString(),
          avgBuyPrice: a.avg_buy_price,
          unitCurrency: a.unit_currency,
          priceKrw: usdKrw.toString(),
          valueKrw: value.toString(),
          source: 'fx',
        });
        continue;
      }
    }
    unpriced.push({ currency: a.currency, balance: qty.toString() });
    holdings.push({
      currency: a.currency,
      qty: qty.toString(),
      avgBuyPrice: a.avg_buy_price,
      unitCurrency: a.unit_currency,
      priceKrw: null,
      valueKrw: null,
      source: 'unpriced',
    });
  }

  return { totalKrw: cashKrw.plus(cryptoKrw), cashKrw, cryptoKrw, unpriced, holdings };
}
