import { signBithumbJWT } from './bithumb.js';

const BITHUMB_API = 'https://api.bithumb.com';

// 빗썸 v2 = 업비트 호환이지만 path 만 다름. closed 분리 endpoint 없고
// /v1/orders?market=KRW-BTC&state=done&limit=100&page=N 로 통합.
// time-range 파라미터 없음 → page-based + early stop on cutoff.
// 응답 shape 는 업비트 호환 (uuid / side / market / price / volume /
// executed_volume / paid_fee / created_at).
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

const PER_PAGE = 100; // 빗썸 v2 limit max 100 (업비트는 1000)
const MAX_PAGES = 100; // 한 종목 1만 건 안전판
const SAFETY_OVERLAP_MS = 60 * 60 * 1000;

// since (epoch ms) 가 주어지면 since-1h 이상의 order 까지만 가져오고 stop.
// 미지정 시 MAX_PAGES 까지 walk (initial backfill).
export async function getBithumbClosedOrders(
  market: string,
  since?: number,
): Promise<BithumbOrder[]> {
  const out: BithumbOrder[] = [];
  const cutoff =
    since !== undefined && since !== null ? since - SAFETY_OVERLAP_MS : null;

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

    if (cutoff !== null) {
      let stopped = false;
      for (const o of batch) {
        const ts = new Date(o.created_at).getTime();
        if (ts < cutoff) {
          stopped = true;
          break;
        }
        out.push(o);
      }
      if (stopped) break;
    } else {
      out.push(...batch);
    }

    if (batch.length < PER_PAGE) break;
  }
  return out;
}
