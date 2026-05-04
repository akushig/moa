import { signUpbitJWT } from './upbit.js';

const UPBIT_API = 'https://api.upbit.com';

// /v1/orders/closed 응답 형태 — 업비트 docs 기반.
// `done` = 체결 완료, `cancel` = 취소. side = `bid` (매수) | `ask` (매도).
// price/volume/executed_volume 은 string. paid_fee = 수수료(KRW).
// 부분 체결 케이스 → executed_volume × trades_avg_price 가 실제 체결액.
// trades 배열이 있을 수도 있으나 단순 dogfood 는 executed_volume × price 로 충분.
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
  const qs = new URLSearchParams(query).toString();
  return fetch(`${UPBIT_API}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

// 주어진 market 의 체결 완료 주문 최근 N 건. v0.1 dogfood 는 페이지당 1000 으로 충분.
// 1000 건 초과 거래자는 v0.5+ 에서 time-window walk 추가.
export async function getUpbitClosedOrders(
  market: string,
  limit = 1000,
): Promise<UpbitOrder[]> {
  const res = await authFetch('/v1/orders/closed', {
    market,
    state: 'done',
    limit: String(limit),
    order_by: 'desc',
  });
  if (!res.ok) {
    throw new Error(`업비트 orders/closed (${market}) ${res.status}: ${await res.text()}`);
  }
  const j = (await res.json()) as unknown;
  if (!Array.isArray(j)) {
    throw new Error(`업비트 orders/closed non-array: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j as UpbitOrder[];
}
