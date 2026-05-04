// Vercel 측 historical 가격 조회 (retroactive view + binance deposit fair-value 용).
//
// 우선순위:
//   1) PriceSnapshot 테이블 (이전 /sync 시점 가격, 1시간 이내 데이터 있으면 사용)
//   2) Upbit/Bithumb /v1/candles/minutes/1, Binance /api/v3/klines (1m)
//   3) Upbit/Bithumb /v1/candles/days fallback
//
// market 포맷:
//   - upbit/bithumb: 'KRW-XYZ'
//   - binance: 'USDT-XYZ'   (PriceSnapshot 측 컨벤션 동일)
import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/decimal';

const cache = new Map<string, string | null>();

type Source = 'upbit' | 'bithumb' | 'binance';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtMinuteParam(source: 'upbit' | 'bithumb', timestampMs: number): string {
  const nextMinute = Math.ceil(timestampMs / 60_000) * 60_000;
  if (source === 'upbit') return new Date(nextMinute).toISOString().replace('.000Z', 'Z');
  const kst = new Date(nextMinute + 9 * 60 * 60 * 1000);
  return (
    `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}` +
    `T${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:00`
  );
}

function fmtDayParam(source: 'upbit' | 'bithumb', timestampMs: number): string {
  const kst = new Date(timestampMs + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = pad(kst.getUTCMonth() + 1);
  const dd = pad(kst.getUTCDate());
  if (source === 'upbit') {
    const utc = new Date(`${yyyy}-${mm}-${dd}T23:59:59+09:00`);
    return utc.toISOString().replace('.000Z', 'Z');
  }
  return `${yyyy}-${mm}-${dd}T23:59:59`;
}

async function fetchKrwCandle(
  source: 'upbit' | 'bithumb',
  path: '/v1/candles/minutes/1' | '/v1/candles/days',
  market: string,
  to: string,
): Promise<string | null> {
  const base = source === 'upbit' ? 'https://api.upbit.com' : 'https://api.bithumb.com';
  const url = `${base}${path}?market=${market}&count=1&to=${encodeURIComponent(to)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as unknown;
    if (!Array.isArray(j) || j.length === 0) return null;
    const candle = j[0] as { trade_price?: number };
    if (typeof candle.trade_price !== 'number' || !Number.isFinite(candle.trade_price)) return null;
    return String(candle.trade_price);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Binance public klines — 분봉 close 가격. symbol = 'XYZUSDT'.
async function fetchBinanceKline(symbol: string, timestampMs: number): Promise<string | null> {
  const startTime = Math.floor(timestampMs / 60_000) * 60_000;
  const endTime = startTime + 60_000;
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&endTime=${endTime}&limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as unknown;
    if (!Array.isArray(j) || j.length === 0) return null;
    // klines: [openTime, open, high, low, close, volume, ...]
    const close = (j[0] as unknown[])[4];
    if (typeof close !== 'string') return null;
    return Number.isFinite(Number(close)) ? close : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getHistoricalPriceAt(
  source: Source,
  market: string,
  timestampMs: number,
): Promise<Decimal | null> {
  // 1) PriceSnapshot
  const snap = await prisma.priceSnapshot.findFirst({
    where: {
      source,
      market,
      takenAt: { lte: new Date(timestampMs) },
    },
    orderBy: { takenAt: 'desc' },
  });
  if (snap) {
    const ageMs = timestampMs - snap.takenAt.getTime();
    if (ageMs >= 0 && ageMs < 60 * 60 * 1000) {
      return new Decimal(String(snap.price));
    }
  }

  if (source === 'binance') {
    const dash = market.indexOf('-');
    if (dash < 0) return null;
    const quote = market.slice(0, dash);
    const base = market.slice(dash + 1);
    const symbol = `${base}${quote}`;
    const cacheKey = `binance::${symbol}::1m::${Math.floor(timestampMs / 60_000) * 60_000}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, await fetchBinanceKline(symbol, timestampMs));
    }
    const v = cache.get(cacheKey);
    return v ? new Decimal(v) : null;
  }

  // upbit/bithumb
  const cacheKey = `${source}::${market}::1m::${Math.ceil(timestampMs / 60_000) * 60_000}`;
  if (!cache.has(cacheKey)) {
    cache.set(
      cacheKey,
      await fetchKrwCandle(source, '/v1/candles/minutes/1', market, fmtMinuteParam(source, timestampMs)),
    );
  }
  const minute = cache.get(cacheKey);
  if (minute) return new Decimal(minute);

  const dayKey = `${source}::${market}::1d::${fmtDayParam(source, timestampMs)}`;
  if (!cache.has(dayKey)) {
    cache.set(
      dayKey,
      await fetchKrwCandle(source, '/v1/candles/days', market, fmtDayParam(source, timestampMs)),
    );
  }
  const day = cache.get(dayKey);
  return day ? new Decimal(day) : null;
}

// 여러 holdings 의 가격을 동시 fetch (concurrency 8). retroactive view 전용.
// 거래소별 quote 단위:
//   - upbit/bithumb: KRW (반환값도 KRW)
//   - binance: USDT (caller 가 FxRate 곱해서 KRW 환산)
export async function fetchPricesForHoldings(
  holdings: { exchange: string; symbol: string }[],
  asOfMs: number,
): Promise<Map<string, Decimal | null>> {
  const out = new Map<string, Decimal | null>();
  const CHUNK = 8;
  for (let i = 0; i < holdings.length; i += CHUNK) {
    const chunk = holdings.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (h) => {
        const isBinance = h.exchange === 'binance';
        const market = isBinance ? `USDT-${h.symbol}` : `KRW-${h.symbol}`;
        const source = isBinance ? 'binance' : (h.exchange as 'upbit' | 'bithumb');
        const price = await getHistoricalPriceAt(source, market, asOfMs);
        return [`${h.exchange}::${h.symbol}`, price] as const;
      }),
    );
    for (const [k, v] of results) out.set(k, v);
  }
  return out;
}
