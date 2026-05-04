// Vercel 측 Binance 연동.
// 워커 (GCP us-west1) IP 가 미국 region 으로 분류되어 Binance HTTP 451
// (regional restriction). 해결: Vercel function 을 한국 region (icn1) 에 pin
// 해서 직접 호출. Binance 가 한국 IP 허용. IP whitelist 미사용 (Vercel egress IP
// 동적), Read-only key 권한으로만 보안.
//
// 워커 측 worker/src/exchanges/binance.ts 와 같은 로직. 둘 다 별도 npm package
// 라 코드 공유 안 됨 → 의도적 duplication.
import crypto from 'node:crypto';
import { Decimal } from '@/lib/decimal';
import { prisma } from '@/lib/db';

const BINANCE_API = 'https://api.binance.com';

export type BinanceBalance = { asset: string; free: string; locked: string };

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
    cache: 'no-store',
  });
}

const USDT_PARITY = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'DAI']);

export type BinanceHolding = {
  currency: string;
  qty: string;
  avgBuyPrice: string | null;
  unitCurrency: string;
  priceKrw: string | null; // 단위는 USDT
  valueKrw: string | null;
  source: 'krw_market' | 'usdt_market' | 'fx' | 'parity' | 'unpriced';
};

export type BinanceSyncResult = {
  ok: boolean;
  totalUsdt?: string;
  cashUsdt?: string;
  cryptoUsdt?: string;
  holdingsCount?: number;
  unpricedCount?: number;
  error?: string;
};

export async function syncBinance(): Promise<BinanceSyncResult> {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET_KEY) {
    return { ok: false, error: 'BINANCE_API_KEY/SECRET not set in Vercel env' };
  }
  try {
    // 1) 잔고
    const acctRes = await authFetch('/api/v3/account');
    if (!acctRes.ok) {
      throw new Error(`Binance /api/v3/account ${acctRes.status}: ${await acctRes.text()}`);
    }
    const acct = (await acctRes.json()) as { balances: BinanceBalance[] };
    const nonZero = (acct.balances ?? []).filter((b) =>
      new Decimal(b.free).plus(b.locked).gt(0),
    );

    // 2) tradable USDT 페어
    const exInfoRes = await fetch(`${BINANCE_API}/api/v3/exchangeInfo?permissions=SPOT`, {
      cache: 'no-store',
    });
    if (!exInfoRes.ok) throw new Error(`Binance exchangeInfo ${exInfoRes.status}`);
    const exInfo = (await exInfoRes.json()) as {
      symbols: { symbol: string; status: string }[];
    };
    const tradable = new Set(
      exInfo.symbols.filter((s) => s.status === 'TRADING').map((s) => s.symbol),
    );

    // 3) ticker price 일괄 fetch
    const cryptoSymbols: string[] = [];
    for (const b of nonZero) {
      if (USDT_PARITY.has(b.asset)) continue;
      const sym = `${b.asset}USDT`;
      if (tradable.has(sym)) cryptoSymbols.push(sym);
    }
    let priceMap = new Map<string, string>();
    if (cryptoSymbols.length > 0) {
      const symbolsParam = JSON.stringify(cryptoSymbols).replace(/\s/g, '');
      const priceRes = await fetch(
        `${BINANCE_API}/api/v3/ticker/price?symbols=${encodeURIComponent(symbolsParam)}`,
        { cache: 'no-store' },
      );
      if (!priceRes.ok) throw new Error(`Binance ticker ${priceRes.status}`);
      const arr = (await priceRes.json()) as { symbol: string; price: string }[];
      priceMap = new Map(arr.map((t) => [t.symbol, t.price]));
    }

    // 4) breakdown
    let cash = new Decimal(0);
    let crypto = new Decimal(0);
    const unpriced: { currency: string; balance: string }[] = [];
    const holdings: BinanceHolding[] = [];

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
        continue;
      }
      const sym = `${b.asset}USDT`;
      const price = tradable.has(sym) ? priceMap.get(sym) : undefined;
      if (!price) {
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

    const total = cash.plus(crypto);
    const takenAt = new Date();

    // 5) BalanceSnapshot insert
    await prisma.balanceSnapshot.create({
      data: {
        takenAt,
        exchange: 'binance',
        quoteCurrency: 'USDT',
        totalKrw: total.toString(),
        cashKrw: cash.toString(),
        cryptoKrw: crypto.toString(),
        unpricedJson: JSON.stringify(unpriced),
        rawJson: JSON.stringify({ holdings }),
      },
    });

    // 6) PriceSnapshot insert (priced holdings 만)
    const priceRows = holdings
      .filter((h) => h.priceKrw && h.source === 'usdt_market')
      .map((h) => ({
        takenAt,
        market: `USDT-${h.currency}`,
        price: h.priceKrw!,
        source: 'binance',
      }));
    if (priceRows.length > 0) {
      await prisma.priceSnapshot.createMany({ data: priceRows });
    }

    return {
      ok: true,
      totalUsdt: total.toString(),
      cashUsdt: cash.toString(),
      cryptoUsdt: crypto.toString(),
      holdingsCount: holdings.length,
      unpricedCount: unpriced.length,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
