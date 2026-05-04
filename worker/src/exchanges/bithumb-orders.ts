import { signBithumbJWT } from './bithumb.js';

const BITHUMB_API = 'https://api.bithumb.com';

// 빗썸 v2 = 업비트 호환이지만 path 만 다름. closed 분리 endpoint 없고
// /v1/orders?market=KRW-BTC&state=done&limit=1000 로 통합.
// 응답 shape 는 업비트 호환 가정 (uuid / side / market / price / volume /
// executed_volume / paid_fee). 차이 발견 시 normalize 추가.
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

// 빗썸 v2 limit max 100 (업비트는 1000) → page 페이징.
// MAX_PAGES 는 v0.1 dogfood safeguard. 1000 건이면 한 종목 거래에 충분.
const PER_PAGE = 100;
const MAX_PAGES = 10;

export async function getBithumbClosedOrders(market: string): Promise<BithumbOrder[]> {
  const all: BithumbOrder[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await authFetch('/v1/orders', {
      market,
      state: 'done',
      limit: String(PER_PAGE),
      page: String(page),
      order_by: 'desc',
    });
    if (!res.ok) {
      throw new Error(`빗썸 orders (${market}, page ${page}) ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as unknown;
    if (!Array.isArray(j)) {
      throw new Error(`빗썸 orders non-array: ${JSON.stringify(j).slice(0, 200)}`);
    }
    const batch = j as BithumbOrder[];
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return all;
}
