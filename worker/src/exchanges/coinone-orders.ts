// 코인원 체결내역 — worker ingest 용.
// v2.1 POST /v2.1/order/complete_orders
// from_ts / to_ts 로 90일 윈도우 페이징. HMAC-SHA512 auth.
import crypto from 'node:crypto';

const COINONE_API = 'https://api.coinone.co.kr';
const WINDOW_90D_MS = 90 * 24 * 3600_000;

function signCoinone(
  accessToken: string,
  secretKey: string,
  body: Record<string, unknown>,
): { payload: string; signature: string } {
  const fullBody = { ...body, access_token: accessToken, nonce: crypto.randomUUID() };
  const payload = Buffer.from(JSON.stringify(fullBody)).toString('base64');
  const signature = crypto
    .createHmac('sha512', secretKey.toUpperCase())
    .update(payload)
    .digest('hex');
  return { payload, signature };
}

export type CoinoneOrder = {
  order_id: string;
  timestamp: string; // epoch ms string
  target_currency: string; // BTC
  quote_currency: string; // KRW
  type: 'buy' | 'sell';
  qty: string;
  price: string; // per-unit
  fee: string;
  fee_rate: string;
};

async function fetchWindow(
  accessToken: string,
  secretKey: string,
  targetCurrency: string,
  fromTs: number,
  toTs: number,
): Promise<CoinoneOrder[]> {
  const orders: CoinoneOrder[] = [];
  for (let page = 0; page < 100; page++) {
    const body: Record<string, unknown> = {
      target_currency: targetCurrency,
      quote_currency: 'KRW',
      from_ts: Math.floor(fromTs / 1000), // 코인원은 seconds
      to_ts: Math.floor(toTs / 1000),
      page,
      size: 100,
    };
    const { payload, signature } = signCoinone(accessToken, secretKey, body);
    const res = await fetch(`${COINONE_API}/v2.1/order/complete_orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-COINONE-PAYLOAD': payload,
        'X-COINONE-SIGNATURE': signature,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`코인원 orders ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { complete_orders?: CoinoneOrder[] };
    const batch = json.complete_orders ?? [];
    orders.push(...batch);
    if (batch.length < 100) break;
  }
  return orders;
}

// since (epoch ms) → now 까지 90일 윈도우로 walk. since 미지정 시 5년 backfill.
export async function getCoinoneCompleteOrders(
  targetCurrency: string,
  since?: number,
): Promise<CoinoneOrder[]> {
  const accessToken = process.env.COINONE_ACCESS_TOKEN;
  const secretKey = process.env.COINONE_SECRET_KEY;
  if (!accessToken || !secretKey) throw new Error('COINONE_ACCESS_TOKEN / COINONE_SECRET_KEY not set');

  const now = Date.now();
  const start = since ?? now - 5 * 365 * 24 * 3600_000; // 5년
  const all: CoinoneOrder[] = [];

  let windowStart = start;
  while (windowStart < now) {
    const windowEnd = Math.min(windowStart + WINDOW_90D_MS, now);
    const batch = await fetchWindow(accessToken, secretKey, targetCurrency, windowStart, windowEnd);
    all.push(...batch);
    windowStart = windowEnd;
  }

  // since 이전 건 제거 (overlap 안전)
  if (since) return all.filter((o) => Number(o.timestamp) > since);
  return all;
}
