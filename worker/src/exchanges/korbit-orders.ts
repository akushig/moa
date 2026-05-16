// 코빗 체결내역 — worker ingest 용.
// GET /v1/user/orders?currency_pair=btc_krw&status=filled

const KORBIT_API = 'https://api.korbit.co.kr';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const clientId = process.env.KORBIT_CLIENT_ID;
  const clientSecret = process.env.KORBIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('KORBIT_CLIENT_ID / KORBIT_CLIENT_SECRET not set');
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;

  const res = await fetch(`${KORBIT_API}/v1/oauth2/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`코빗 oauth ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 - 60000 };
  return tokenCache.token;
}

export type KorbitOrder = {
  id: string;
  currency_pair: string; // btc_krw
  side: 'bid' | 'ask';
  avg_price: string;
  order_amount: string; // filled qty
  fee: string;
  created_at: string; // epoch ms string
  filled_at: string;
};

export async function getKorbitFilledOrders(
  currencyPair: string,
  since?: number,
): Promise<KorbitOrder[]> {
  const token = await getToken();
  const orders: KorbitOrder[] = [];
  let offset = 0;
  const limit = 40;

  for (let page = 0; page < 100; page++) {
    const url = `${KORBIT_API}/v1/user/orders?currency_pair=${currencyPair}&status=filled&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`코빗 orders ${res.status}: ${await res.text()}`);
    const batch = (await res.json()) as KorbitOrder[];

    for (const o of batch) {
      if (since && Number(o.created_at) <= since) continue;
      orders.push(o);
    }

    if (batch.length < limit) break;
    if (since && batch.some((o) => Number(o.created_at) <= since)) break;
    offset += limit;
  }

  return orders;
}
