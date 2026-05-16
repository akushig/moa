// 코빗 API v2
// Auth: HMAC-SHA256 — X-KAPI-KEY 헤더 + signature 파라미터
// 잔고: GET /v2/balance
// 체결내역: GET /v2/myTrades (36시간 제한 — 자주 poll 필요)
// Ticker: GET /v2/ticker?symbol=btc_krw

import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';
import { getUsdKrwRate } from '../fx.js';

const KORBIT_API = 'https://api.korbit.co.kr';

function signKorbit(
  secret: string,
  params: URLSearchParams,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(params.toString(), 'utf-8')
    .digest('hex');
}

async function korbitGet<T>(
  path: string,
  extraParams?: Record<string, string>,
): Promise<T> {
  const apiKey = process.env.KORBIT_API_KEY;
  const apiSecret = process.env.KORBIT_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error('KORBIT_API_KEY / KORBIT_API_SECRET not set');

  const params = new URLSearchParams({
    ...extraParams,
    timestamp: Date.now().toString(),
  });
  const signature = signKorbit(apiSecret, params);
  params.append('signature', signature);

  const res = await fetch(`${KORBIT_API}${path}?${params}`, {
    headers: { 'X-KAPI-KEY': apiKey },
  });
  if (!res.ok) throw new Error(`코빗 ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

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

type BalanceResponse = {
  balance: { currency: string; value: string }[];
  pendingOrders?: { currency: string; value: string }[];
};

// 코빗 ticker — 개별 심볼 조회 (all 엔드포인트 없음)
async function getKorbitPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(`${KORBIT_API}/v2/ticker?symbol=${symbol}`);
    if (!res.ok) return null;
    const json = (await res.json()) as { last?: string };
    return json.last ? Number(json.last) : null;
  } catch {
    return null;
  }
}

// 코빗에서 거래 가능한 심볼 목록 (public)
let cachedSymbols: string[] | null = null;
async function getKorbitSymbols(): Promise<string[]> {
  if (cachedSymbols) return cachedSymbols;
  try {
    const res = await fetch(`${KORBIT_API}/v2/ticker?symbol=all`);
    if (!res.ok) return [];
    const json = (await res.json()) as Record<string, unknown>;
    cachedSymbols = Object.keys(json).filter((k) => k.endsWith('_krw'));
    return cachedSymbols;
  } catch {
    return [];
  }
}

export async function getKorbitTickers(): Promise<Map<string, number>> {
  const symbols = await getKorbitSymbols();
  const map = new Map<string, number>();
  // 병렬로 ticker 조회 (rate limit 5/s 이므로 chunk)
  const CHUNK = 5;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const batch = symbols.slice(i, i + CHUNK);
    const results = await Promise.all(batch.map((s) => getKorbitPrice(s)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j] !== null) {
        const coin = batch[j].replace('_krw', '').toUpperCase();
        map.set(coin, results[j]!);
      }
    }
  }
  return map;
}

export async function getKorbitKrwBreakdown(): Promise<KorbitKrwBreakdown> {
  const balRes = await korbitGet<BalanceResponse>('/v2/balance');
  const balances = balRes.balance ?? [];
  const pending = balRes.pendingOrders ?? [];

  // pending orders 도 합산 (잔고에서 빠진 상태)
  const combined = new Map<string, Decimal>();
  for (const b of [...balances, ...pending]) {
    const cur = b.currency.toUpperCase();
    const prev = combined.get(cur) ?? new Decimal(0);
    combined.set(cur, prev.plus(b.value));
  }

  let cashKrw = new Decimal(0);
  let cryptoKrw = new Decimal(0);
  const unpriced: { currency: string; balance: string }[] = [];
  const holdings: KorbitHolding[] = [];
  const FX_FALLBACK = new Set(['USDT', 'USDC', 'DAI', 'BUSD']);

  const coinAccounts: { currency: string; qty: Decimal }[] = [];
  for (const [cur, qty] of combined) {
    if (qty.lte(0)) continue;
    if (cur === 'KRW') {
      cashKrw = cashKrw.plus(qty);
      continue;
    }
    coinAccounts.push({ currency: cur, qty });
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
        holdings.push({ currency: a.currency, qty: a.qty.toString(), avgBuyPrice: '0', unitCurrency: 'KRW', priceKrw: usdKrw.toString(), valueKrw: value.toString(), source: 'fx' });
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
