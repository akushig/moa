import { signUpbitJWT, buildUpbitQs } from './upbit.js';

const UPBIT_API = 'https://api.upbit.com';

// /v1/orders/closed 응답 형태 — 업비트 docs 기반.
// `done` = 체결 완료. side = `bid` (매수) | `ask` (매도).
// price/volume/executed_volume 은 string. paid_fee = 수수료(KRW).
export type UpbitOrder = {
  uuid: string;
  side: 'bid' | 'ask';
  ord_type: string;
  state: string;
  market: string; // KRW-BTC
  created_at: string; // ISO 8601 (KST tz)
  price: string | null;
  volume: string | null;
  executed_volume: string;
  paid_fee: string;
  trades_count?: number;
};

async function authFetch(path: string, query: Record<string, string>): Promise<Response> {
  const accessKey = process.env.UPBIT_ACCESS_KEY;
  const secretKey = process.env.UPBIT_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('UPBIT_ACCESS_KEY / UPBIT_SECRET_KEY not set');
  const jwt = await signUpbitJWT(accessKey, secretKey, query);
  // hash 와 URL 모두 동일 canonical 형태 (": / + raw") 사용
  const qs = buildUpbitQs(query);
  return fetch(`${UPBIT_API}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

// Upbit /v1/orders/closed: 시간 윈도우 max 7일 (param 미지정 시 default 도 7일).
// → 전체 history 가져오려면 7일씩 walk.
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SAFETY_OVERLAP_MS = 60 * 60 * 1000; // 1h 안전 마진 (clock skew / fee settle 지연)
// 첫 ingest = 진짜 풀 backfill. 5년치 (260 windows) 까지 walk, early stop 없음.
// 5년 = Upbit 서비스 시작 (2017) 부터 사실상 모든 user 의 history 커버.
const MAX_BACKWARD_WINDOWS = 260;

async function fetchWindow(market: string, startMs: number, endMs: number): Promise<UpbitOrder[]> {
  const res = await authFetch('/v1/orders/closed', {
    market,
    state: 'done',
    limit: '1000',
    order_by: 'desc',
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(endMs).toISOString(),
  });
  if (!res.ok) {
    const range = `${new Date(startMs).toISOString()}~${new Date(endMs).toISOString()}`;
    throw new Error(`업비트 orders/closed (${market}, ${range}) ${res.status}: ${await res.text()}`);
  }
  const j = (await res.json()) as unknown;
  if (!Array.isArray(j)) {
    throw new Error(`업비트 orders/closed non-array: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j as UpbitOrder[];
}

// since (epoch ms) 가 주어지면 since-1h → now 까지 forward walk (incremental).
// 미지정 시 now → 약 14개월 전 까지 backward walk (initial backfill).
export async function getUpbitClosedOrders(
  market: string,
  since?: number,
): Promise<UpbitOrder[]> {
  const out: UpbitOrder[] = [];
  const now = Date.now();

  if (since !== undefined && since !== null) {
    let start = Math.max(0, since - SAFETY_OVERLAP_MS);
    while (start < now) {
      const end = Math.min(start + WINDOW_MS, now);
      out.push(...(await fetchWindow(market, start, end)));
      start = end;
    }
    return out;
  }

  let end = now;
  for (let i = 0; i < MAX_BACKWARD_WINDOWS; i += 1) {
    const start = end - WINDOW_MS;
    out.push(...(await fetchWindow(market, start, end)));
    end = start;
  }
  return out;
}
