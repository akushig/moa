import crypto from 'node:crypto';
import { Decimal } from 'decimal.js';

// Binance Spot API:
//   - Auth: HMAC-SHA256. signed endpoint 는 timestamp + signature 필요.
//   - signature = HMAC_SHA256(secret, totalParams) — totalParams = querystring.
//   - Header: X-MBX-APIKEY: <api_key>
//   - Quote 통화 = USDT (또는 USDC/FDUSD 등 stablecoin). 한국 거래소처럼 KRW 페어 없음.
//
// Read-only key 권한으로 충분. 호출 endpoint:
//   - GET /api/v3/account (balances)
//   - GET /api/v3/ticker/price?symbols=[...] (public)
//   - GET /api/v3/myTrades (Phase 2 거래내역, 별 파일)
//   - GET /sapi/v1/capital/deposit/hisrec (Phase 3)
//   - GET /sapi/v1/capital/withdraw/history (Phase 3)
const BINANCE_API = 'https://api.binance.com';

export type BinanceBalance = {
  asset: string;     // BTC, USDT, ETH, ...
  free: string;
  locked: string;
};

export type BinanceAccountResp = {
  balances: BinanceBalance[];
  // canTrade, canWithdraw, etc. 무시
};

function sign(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function authFetch(path: string, query: Record<string, string> = {}): Promise<Response> {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET_KEY;
  if (!apiKey || !secret) throw new Error('BINANCE_API_KEY / BINANCE_SECRET_KEY not set');
  const q: Record<string, string> = { ...query, timestamp: String(Date.now()), recvWindow: '10000' };
  const qs = new URLSearchParams(q).toString();
  const signature = sign(secret, qs);
  return fetch(`${BINANCE_API}${path}?${qs}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
}

export async function getBinanceAccount(): Promise<BinanceAccountResp> {
  const res = await authFetch('/api/v3/account');
  if (!res.ok) throw new Error(`Binance /api/v3/account ${res.status}: ${await res.text()}`);
  return (await res.json()) as BinanceAccountResp;
}

// Public ticker prices. symbols 파라미터로 multi-fetch. e.g. symbols=["BTCUSDT","ETHUSDT"]
export async function getBinancePrices(symbols: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (symbols.length === 0) return map;
  // 한 번에 최대 1500 symbols 가능. 청크 안 함.
  const symbolsParam = JSON.stringify(symbols).replace(/\s/g, '');
  const url = `${BINANCE_API}/api/v3/ticker/price?symbols=${encodeURIComponent(symbolsParam)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { symbol: string; price: string }[];
  for (const t of j) map.set(t.symbol, t.price);
  return map;
}

// 모든 USDT 페어 (그리고 USDC 페어 일부) 사전 검증용. 거래 가능한 pair 만 return.
// /api/v3/exchangeInfo 가 정확하지만 큼 (~500KB). 단순 check 라 ticker 결과로 충분.
// → getBinancePrices 가 invalid symbol 만나면 에러 → caller 가 무시. 위험 회피로
//   exchangeInfo 사용해서 valid symbol 만 query.
export async function getBinanceTradableSymbols(): Promise<Set<string>> {
  const url = `${BINANCE_API}/api/v3/exchangeInfo?permissions=SPOT`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance exchangeInfo ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { symbols: { symbol: string; status: string }[] };
  const out = new Set<string>();
  for (const s of j.symbols ?? []) {
    if (s.status === 'TRADING') out.add(s.symbol);
  }
  return out;
}

// USDT 1:1 가정 stablecoin (KRW 마켓 없는 외화 stablecoin 처리 시).
const USDT_PARITY = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI']);

// 필드명은 upbit/bithumb 와 통일 (priceKrw/valueKrw — 단위는 BalanceSnapshot.quoteCurrency
// 통화. binance 는 USDT.) avgBuyPrice 는 binance 가 응답 안 줘서 null.
export type BinanceHolding = {
  currency: string;
  qty: string;
  avgBuyPrice: string | null;
  unitCurrency: string;
  priceKrw: string | null;  // 실제 단위는 USDT
  valueKrw: string | null;
  source: 'krw_market' | 'usdt_market' | 'fx' | 'parity' | 'unpriced';
};

export type BinanceUsdtBreakdown = {
  totalUsdt: Decimal;       // cash + crypto
  cashUsdt: Decimal;        // USDT + 다른 stablecoin (1:1 가정)
  cryptoUsdt: Decimal;
  unpriced: { currency: string; balance: string }[];
  holdings: BinanceHolding[];
};

export async function getBinanceUsdtBreakdown(): Promise<BinanceUsdtBreakdown> {
  const acct = await getBinanceAccount();
  const nonZero = (acct.balances ?? []).filter((b) =>
    new Decimal(b.free).plus(b.locked).gt(0),
  );

  let cash = new Decimal(0);
  let crypto = new Decimal(0);
  const unpriced: { currency: string; balance: string }[] = [];
  const holdings: BinanceHolding[] = [];

  // 1) USDT / USDC 등 stablecoin 처리 (cash 로 분류, 1:1 가정).
  // 2) 그 외 코인: USDT pair 가 trading 중인 것만 valuation, 아니면 unpriced.
  const tradable = await getBinanceTradableSymbols();
  const cryptoBalances: BinanceBalance[] = [];
  for (const b of nonZero) {
    const qty = new Decimal(b.free).plus(b.locked);
    if (USDT_PARITY.has(b.asset)) {
      cash = cash.plus(qty);
      holdings.push({
        currency: b.asset,
        qty: qty.toString(),
        avgBuyPrice: null,
        unitCurrency: 'USDT',
        priceKrw: '1',
        valueKrw: qty.toString(),
        source: 'parity',
      });
    } else {
      cryptoBalances.push(b);
    }
  }

  const symbols: string[] = [];
  for (const b of cryptoBalances) {
    const sym = `${b.asset}USDT`;
    if (tradable.has(sym)) symbols.push(sym);
  }
  const priceMap = await getBinancePrices(symbols);

  for (const b of cryptoBalances) {
    const qty = new Decimal(b.free).plus(b.locked);
    const sym = `${b.asset}USDT`;
    if (!tradable.has(sym) || !priceMap.get(sym)) {
      unpriced.push({ currency: b.asset, balance: qty.toString() });
      holdings.push({
        currency: b.asset,
        qty: qty.toString(),
        avgBuyPrice: null,
        unitCurrency: 'USDT',
        priceKrw: null,
        valueKrw: null,
        source: 'unpriced',
      });
      continue;
    }
    const price = priceMap.get(sym)!;
    const value = qty.times(price);
    crypto = crypto.plus(value);
    holdings.push({
      currency: b.asset,
      qty: qty.toString(),
      avgBuyPrice: null,
      unitCurrency: 'USDT',
      priceKrw: new Decimal(price).toString(),
      valueKrw: value.toString(),
      source: 'usdt_market',
    });
  }

  return {
    totalUsdt: cash.plus(crypto),
    cashUsdt: cash,
    cryptoUsdt: crypto,
    unpriced,
    holdings,
  };
}
