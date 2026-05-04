// 거래소 historical 가격 조회 (deposit/airdrop fair-value cost 산정용).
//   1) 1분봉 시도 — staking 보상 정확 시점가 매치 (빗썸 알고리즘과 거의 일치)
//   2) 실패 시 일봉 종가 fallback (oldest data / API 일시 장애)
//
// Upbit /v1/candles/minutes/{unit} | /v1/candles/days
// Bithumb /v1/candles/minutes/{unit} | /v1/candles/days  (둘 다 public, no auth)
// 'to' 파라미터:
//   - Upbit: UTC ISO+Z (예: "2025-01-15T01:17:00Z")
//   - Bithumb: KST naive (예: "2025-01-15T10:17:00")
const cache = new Map<string, string | null>();

// timestampMs 가 속한 분 (KST) 다음 분 boundary 를 'to' 로 만들어 그 분의
// 1m candle 을 받아옴. (e.g. 10:16:28 → to=10:17:00 → 10:16-10:17 candle)
function fmtMinuteParam(source: 'upbit' | 'bithumb', timestampMs: number): string {
  const nextMinute = Math.ceil(timestampMs / 60_000) * 60_000;
  const d = new Date(nextMinute);
  if (source === 'upbit') return d.toISOString().replace('.000Z', 'Z');
  // KST naive: KST 시각의 YYYY-MM-DDTHH:MM:00
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

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function minuteKey(timestampMs: number): string {
  const nextMinute = Math.ceil(timestampMs / 60_000) * 60_000;
  return new Date(nextMinute).toISOString().slice(0, 16);
}

function dayKey(timestampMs: number): string {
  const kst = new Date(timestampMs + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}`;
}

async function fetchCandle(
  base: string,
  path: string,
  market: string,
  to: string,
): Promise<string | null> {
  const url = `${base}${path}?market=${market}&count=1&to=${encodeURIComponent(to)}`;
  // 개별 candle 호출 5초 timeout — hang 방지 (분봉 ingest 시 127건 sequential 시 무한 대기 risk)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
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

// deposit 시점 historical 가격. 1분봉 우선, 실패 시 일봉 종가 fallback.
export async function getHistoricalPriceAt(
  source: 'upbit' | 'bithumb',
  market: string, // KRW-SOL
  timestampMs: number,
): Promise<string | null> {
  const base = source === 'upbit' ? 'https://api.upbit.com' : 'https://api.bithumb.com';

  // 1) 1분봉
  const minKey = `${source}::${market}::1m::${minuteKey(timestampMs)}`;
  if (!cache.has(minKey)) {
    const v = await fetchCandle(base, '/v1/candles/minutes/1', market, fmtMinuteParam(source, timestampMs));
    cache.set(minKey, v);
  }
  const minute = cache.get(minKey);
  if (minute) return minute;

  // 2) 일봉 fallback
  const dayK = `${source}::${market}::1d::${dayKey(timestampMs)}`;
  if (!cache.has(dayK)) {
    const v = await fetchCandle(base, '/v1/candles/days', market, fmtDayParam(source, timestampMs));
    cache.set(dayK, v);
  }
  return cache.get(dayK) ?? null;
}

export function _resetHistoricalPriceCache(): void {
  cache.clear();
}
