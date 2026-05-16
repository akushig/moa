// 코인원 체결내역 — worker ingest 용.
// v2.1 POST /v2.1/order/complete_orders
import crypto from 'node:crypto';

const COINONE_API = 'https://api.coinone.co.kr';

function signCoinone(
  accessToken: string,
  secretKey: string,
  body: Record<string, unknown>,
): { payload: string; signature: string } {
  const fullBody = { ...body, access_token: accessToken, nonce: Date.now() };
  const payload = Buffer.from(JSON.stringify(fullBody)).toString('base64');
  const signature = crypto
    .createHmac('sha256', secretKey.toUpperCase())
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

export async function getCoinoneCompleteOrders(
  targetCurrency: string,
  since?: number,
): Promise<CoinoneOrder[]> {
  const accessToken = process.env.COINONE_ACCESS_TOKEN;
  const secretKey = process.env.COINONE_SECRET_KEY;
  if (!accessToken || !secretKey) throw new Error('COINONE_ACCESS_TOKEN / COINONE_SECRET_KEY not set');

  const orders: CoinoneOrder[] = [];

  for (let page = 0; page < 100; page++) {
    const body: Record<string, unknown> = {
      target_currency: targetCurrency,
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

    // since 이전 건은 skip
    for (const o of batch) {
      if (since && Number(o.timestamp) <= since) continue;
      orders.push(o);
    }

    if (batch.length < 100) break;
    // since 보다 이전 건이 등장하면 early stop
    if (since && batch.some((o) => Number(o.timestamp) <= since)) break;
  }

  return orders;
}
