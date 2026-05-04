import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import { getUsdKrwRate } from '../fx.js';

const UPBIT_API = 'https://api.upbit.com';

export type UpbitAccount = {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  avg_buy_price_modified: boolean;
  unit_currency: string;
};

export type UpbitTicker = { market: string; trade_price: number };

// Upbit 의 query_hash 검증 알고리즘은 ":" 와 "+" 를 percent-encoding 안 한
// 형태로 canonical 화한다. URLSearchParams 가 자동으로 %3A / %2B 로 encode
// 하므로 hash + URL 둘 다 raw 로 후처리해야 일치. (영문/숫자/-/_/. 만 쓰는
// query 는 영향 없음.)
export function buildUpbitQs(query: Record<string, string>): string {
  return new URLSearchParams(query)
    .toString()
    .replace(/%3A/g, ':')
    .replace(/%2B/g, '+');
}

export async function signUpbitJWT(
  accessKey: string,
  secretKey: string,
  query?: Record<string, string>,
): Promise<string> {
  const payload: Record<string, unknown> = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
  };
  if (query && Object.keys(query).length > 0) {
    const queryString = buildUpbitQs(query);
    const queryHash = crypto.createHash('sha512').update(queryString).digest('hex');
    payload.query_hash = queryHash;
    payload.query_hash_alg = 'SHA512';
  }
  const secret = new TextEncoder().encode(secretKey);
  return await new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).sign(secret);
}

export async function getUpbitAccounts(): Promise<UpbitAccount[]> {
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY not set');
  const jwt = await signUpbitJWT(accessKey, secretKey);
  const res = await fetch(`${UPBIT_API}/v1/accounts`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`업비트 API ${res.status}: ${await res.text()}`);
  return (await res.json()) as UpbitAccount[];
}

export async function getUpbitTickers(markets: string[]): Promise<UpbitTicker[]> {
  if (markets.length === 0) return [];
  const url = `${UPBIT_API}/v1/ticker?markets=${markets.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`업비트 ticker ${res.status}: ${await res.text()}`);
  return (await res.json()) as UpbitTicker[];
}

// 업비트에 KRW 마켓이 있는 코인 목록. 잔고에 있어도 KRW 거래 페어가 없으면
// /v1/ticker?markets=KRW-XXX 가 404 → 호출 전에 미리 거른다.
export async function getUpbitKrwMarkets(): Promise<Set<string>> {
  const res = await fetch(`${UPBIT_API}/v1/market/all`);
  if (!res.ok) throw new Error(`업비트 market/all ${res.status}: ${await res.text()}`);
  const arr = (await res.json()) as { market: string }[];
  return new Set(arr.filter((m) => m.market.startsWith('KRW-')).map((m) => m.market));
}

// 진정한 stablecoin (KRW 마켓 없을 때만 fx fallback). USDT/USDC 는 업비트에
// KRW 페어가 있으므로 일반 코인처럼 ticker 로 환산 — STABLECOINS set 에서 제외.
const FX_FALLBACK_TO_USD = new Set(['USDT', 'USDC', 'DAI', 'BUSD']);

// 한 코인의 (현재가) 환산 결과
export type UpbitHolding = {
  currency: string;
  qty: string;
  avgBuyPrice: string; // 업비트가 알려주는 값 (참고용 — 실제 평균단가는 transactions 기반)
  unitCurrency: string;
  priceKrw: string | null; // 현재가 KRW. 환산 못한 경우 null.
  valueKrw: string | null; // qty × priceKrw
  source: 'krw_market' | 'fx' | 'unpriced';
};

export type UpbitKrwBreakdown = {
  totalKrw: Decimal;
  cashKrw: Decimal;
  cryptoKrw: Decimal;
  unpriced: { currency: string; balance: string }[];
  holdings: UpbitHolding[];
};

export async function getUpbitKrwBreakdown(): Promise<UpbitKrwBreakdown> {
  const accounts = await getUpbitAccounts();
  const nonZero = accounts.filter((a) => new Decimal(a.balance).plus(a.locked).gt(0));

  let cashKrw = new Decimal(0);
  let cryptoKrw = new Decimal(0);
  const unpriced: { currency: string; balance: string }[] = [];
  const holdings: UpbitHolding[] = [];

  // 1) KRW 현금 분리 + 코인 마켓 후보 수집
  const coinAccounts: UpbitAccount[] = [];
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

  // 2) KRW-XXX 마켓 존재 여부 사전 검증
  const krwMarkets = await getUpbitKrwMarkets();
  const tradable = coinAccounts.filter((a) => krwMarkets.has(`KRW-${a.currency}`));
  const untradable = coinAccounts.filter((a) => !krwMarkets.has(`KRW-${a.currency}`));

  // 3) tradable → ticker 일괄 조회
  const priceMap = new Map<string, number>();
  if (tradable.length > 0) {
    const tickers = await getUpbitTickers(tradable.map((a) => `KRW-${a.currency}`));
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

  // 4) untradable → stablecoin 이면 fx 로 환산, 그 외는 unpriced
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
