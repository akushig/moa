// Vercel 측 historical 가격 조회 (retroactive view 용).
// 워커 측과 동일한 로직 — 단 Vercel 에서 직접 candle API 호출 (public, 무인증).
//
// 우선순위:
//   1) PriceSnapshot 테이블 (이전 /sync 시점 가격, 1시간 이내 데이터 있으면 사용)
//   2) Upbit/Bithumb /v1/candles/minutes/1 (1분봉)
//   3) /v1/candles/days (일봉 종가) fallback
import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/decimal';

const cache = new Map<string, string | null>();

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

async function fetchCandle(
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

// PriceSnapshot 우선 조회 (1시간 이내 데이터). 없으면 candle API.
export async function getHistoricalPriceAt(
  source: 'upbit' | 'bithumb',
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

  // 2) 1분봉 candle
  const cacheKey = `${source}::${market}::1m::${Math.ceil(timestampMs / 60_000) * 60_000}`;
  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, await fetchCandle(source, '/v1/candles/minutes/1', market, fmtMinuteParam(source, timestampMs)));
  }
  const minute = cache.get(cacheKey);
  if (minute) return new Decimal(minute);

  // 3) 일봉 fallback
  const dayKey = `${source}::${market}::1d::${fmtDayParam(source, timestampMs)}`;
  if (!cache.has(dayKey)) {
    cache.set(dayKey, await fetchCandle(source, '/v1/candles/days', market, fmtDayParam(source, timestampMs)));
  }
  const day = cache.get(dayKey);
  return day ? new Decimal(day) : null;
}

// 여러 holdings 의 가격을 동시 fetch (concurrency 8).
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
        const market = `KRW-${h.symbol}`;
        const price = await getHistoricalPriceAt(h.exchange as 'upbit' | 'bithumb', market, asOfMs);
        return [`${h.exchange}::${h.symbol}`, price] as const;
      }),
    );
    for (const [k, v] of results) out.set(k, v);
  }
  return out;
}
