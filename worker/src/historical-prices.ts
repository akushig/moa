// 거래소 일봉 종가 조회 (deposit/airdrop fair-value cost 산정용).
// Upbit /v1/candles/days, Bithumb /v1/candles/days 둘 다 public (auth 불필요).
// 응답 shape 동일: [{ candle_date_time_kst, trade_price, ... }]
// 단 `to` 파라미터 포맷이 다름:
//   - Upbit: "2025-01-15T23:59:59Z" (UTC 표기 필요)
//   - Bithumb: "2025-01-15T23:59:59" (Z 없이, naive KST)
//
// 일봉이라 분단위 정확도는 없음. Staking 보상 cost 산정엔 충분 (소액).
//
// 캐시: (source, market, date) 단위 in-memory. 한 번 조회한 날짜는 재호출 X.
const cache = new Map<string, string | null>();

function fmtToParam(source: 'upbit' | 'bithumb', timestampMs: number): string {
  // 일봉 KST 기준이라, 사용자가 지정한 시점이 속한 KST 일자의 일봉을 받음.
  // KST 다음날 00:00:00 직전을 'to' 로 주면 안전.
  const date = new Date(timestampMs);
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  // KST 일자 + "T23:59:59" → 그날 일봉 마감 직전.
  // Upbit 는 UTC 시각으로 해석하니 KST 23:59 = UTC 14:59 으로 변환해서 보내야 정확.
  if (source === 'upbit') {
    const utc = new Date(`${yyyy}-${mm}-${dd}T23:59:59+09:00`);
    return utc.toISOString().replace('.000Z', 'Z');
  }
  return `${yyyy}-${mm}-${dd}T23:59:59`;
}

function dateKey(timestampMs: number): string {
  const kst = new Date(timestampMs + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export async function getDailyClosePrice(
  source: 'upbit' | 'bithumb',
  market: string, // KRW-SOL
  timestampMs: number,
): Promise<string | null> {
  const key = `${source}::${market}::${dateKey(timestampMs)}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const base = source === 'upbit' ? 'https://api.upbit.com' : 'https://api.bithumb.com';
  const to = fmtToParam(source, timestampMs);
  const url = `${base}/v1/candles/days?market=${market}&count=1&to=${encodeURIComponent(to)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      cache.set(key, null);
      return null;
    }
    const j = (await res.json()) as unknown;
    if (!Array.isArray(j) || j.length === 0) {
      cache.set(key, null);
      return null;
    }
    const candle = j[0] as { trade_price?: number };
    if (typeof candle.trade_price !== 'number' || !Number.isFinite(candle.trade_price)) {
      cache.set(key, null);
      return null;
    }
    const price = String(candle.trade_price);
    cache.set(key, price);
    return price;
  } catch {
    cache.set(key, null);
    return null;
  }
}

export function _resetHistoricalPriceCache(): void {
  cache.clear();
}
