import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';

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
    const queryString = new URLSearchParams(query).toString();
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

const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'DAI']);

export type UpbitKrwBreakdown = {
  totalKrw: Decimal;
  cashKrw: Decimal;
  cryptoKrw: Decimal;
  unpriced: { currency: string; balance: string }[];
};

export async function getUpbitKrwBreakdown(): Promise<UpbitKrwBreakdown> {
  const accounts = await getUpbitAccounts();
  const nonZero = accounts.filter((a) => new Decimal(a.balance).plus(a.locked).gt(0));

  let cashKrw = new Decimal(0);
  let cryptoKrw = new Decimal(0);
  const unpriced: { currency: string; balance: string }[] = [];

  const coinSymbols: string[] = [];
  for (const a of nonZero) {
    if (a.currency === 'KRW') {
      cashKrw = cashKrw.plus(a.balance).plus(a.locked);
    } else if (STABLECOINS.has(a.currency)) {
      unpriced.push({
        currency: a.currency,
        balance: new Decimal(a.balance).plus(a.locked).toString(),
      });
    } else {
      coinSymbols.push(`KRW-${a.currency}`);
    }
  }

  if (coinSymbols.length > 0) {
    const krwMarkets = await getUpbitKrwMarkets();
    const tradable = coinSymbols.filter((m) => krwMarkets.has(m));
    const untradable = coinSymbols.filter((m) => !krwMarkets.has(m));
    for (const m of untradable) {
      const sym = m.slice('KRW-'.length);
      const a = nonZero.find((x) => x.currency === sym)!;
      unpriced.push({
        currency: sym,
        balance: new Decimal(a.balance).plus(a.locked).toString(),
      });
    }
    const tickers = await getUpbitTickers(tradable);
    const priceMap = new Map(tickers.map((t) => [t.market, t.trade_price]));
    for (const a of nonZero) {
      if (a.currency === 'KRW' || STABLECOINS.has(a.currency)) continue;
      if (!krwMarkets.has(`KRW-${a.currency}`)) continue; // already pushed to unpriced
      const price = priceMap.get(`KRW-${a.currency}`);
      if (price === undefined) {
        unpriced.push({
          currency: a.currency,
          balance: new Decimal(a.balance).plus(a.locked).toString(),
        });
        continue;
      }
      cryptoKrw = cryptoKrw.plus(new Decimal(a.balance).plus(a.locked).times(price));
    }
  }

  return { totalKrw: cashKrw.plus(cryptoKrw), cashKrw, cryptoKrw, unpriced };
}
