import { SignJWT } from 'jose';
import crypto from 'node:crypto';
import { Decimal } from '@/lib/decimal';
import { ensureProxyConfigured } from '@/lib/proxy';

// 모듈 첫 import 시 Fixie/HTTPS_PROXY 적용 (Vercel cold start 1회).
ensureProxyConfigured();

const UPBIT_API = 'https://api.upbit.com';

export type UpbitAccount = {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  avg_buy_price_modified: boolean;
  unit_currency: string;
};

export type UpbitTicker = {
  market: string;
  trade_price: number;
};

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
  if (!accessKey || !secretKey) {
    throw new Error('UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY not set in .env.local');
  }
  const jwt = await signUpbitJWT(accessKey, secretKey);
  const res = await fetch(`${UPBIT_API}/v1/accounts`, {
    headers: { Authorization: `Bearer ${jwt}` },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`업비트 API ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

export async function getUpbitTickers(markets: string[]): Promise<UpbitTicker[]> {
  if (markets.length === 0) return [];
  const url = `${UPBIT_API}/v1/ticker?markets=${markets.join(',')}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`업비트 ticker ${res.status}: ${await res.text()}`);
  }
  return await res.json();
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
      // v0.1: 한국은행 fx live fetch 미구현 (Day 2-3) — 일단 unpriced 로 분리
      unpriced.push({ currency: a.currency, balance: new Decimal(a.balance).plus(a.locked).toString() });
    } else {
      coinSymbols.push(`KRW-${a.currency}`);
    }
  }

  if (coinSymbols.length > 0) {
    const tickers = await getUpbitTickers(coinSymbols);
    const priceMap = new Map(tickers.map((t) => [t.market, t.trade_price]));
    for (const a of nonZero) {
      if (a.currency === 'KRW' || STABLECOINS.has(a.currency)) continue;
      const price = priceMap.get(`KRW-${a.currency}`);
      if (price === undefined) {
        unpriced.push({ currency: a.currency, balance: new Decimal(a.balance).plus(a.locked).toString() });
        continue;
      }
      const total = new Decimal(a.balance).plus(a.locked).times(price);
      cryptoKrw = cryptoKrw.plus(total);
    }
  }

  return {
    totalKrw: cashKrw.plus(cryptoKrw),
    cashKrw,
    cryptoKrw,
    unpriced,
  };
}
