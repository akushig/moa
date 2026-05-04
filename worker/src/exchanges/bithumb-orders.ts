import { signBithumbJWT } from './bithumb.js';

const BITHUMB_API = 'https://api.bithumb.com';

// 빗썸 v2 = 업비트 호환. /v1/orders/closed?market=KRW-BTC&state=done&limit=1000.
// 응답도 동일 shape 가정 (uuid / side / market / price / volume / executed_volume / paid_fee).
// 차이 발견 시 normalize 만 추가하면 됨.
export type BithumbOrder = {
  uuid: string;
  side: 'bid' | 'ask';
  ord_type: string;
  state: string;
  market: string;
  created_at: string;
  price: string | null;
  volume: string | null;
  executed_volume: string;
  paid_fee: string;
  trades_count?: number;
};

async function authFetch(path: string, query: Record<string, string>): Promise<Response> {
  const accessKey = process.env.BITHUMB_ACCESS_KEY;
  const secretKey = process.env.BITHUMB_SECRET_KEY;
  if (!accessKey || !secretKey) throw new Error('BITHUMB_ACCESS_KEY / BITHUMB_SECRET_KEY not set');
  const jwt = await signBithumbJWT(accessKey, secretKey, query);
  const qs = new URLSearchParams(query).toString();
  return fetch(`${BITHUMB_API}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

export async function getBithumbClosedOrders(
  market: string,
  limit = 1000,
): Promise<BithumbOrder[]> {
  const res = await authFetch('/v1/orders/closed', {
    market,
    state: 'done',
    limit: String(limit),
    order_by: 'desc',
  });
  if (!res.ok) {
    throw new Error(`빗썸 orders/closed (${market}) ${res.status}: ${await res.text()}`);
  }
  const j = (await res.json()) as unknown;
  if (!Array.isArray(j)) {
    // 빗썸은 invalid → HTTP 200 + {error:{...}} 반환할 수 있음
    throw new Error(`빗썸 orders/closed non-array: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j as BithumbOrder[];
}
