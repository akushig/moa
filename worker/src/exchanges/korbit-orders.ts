// 코빗 체결내역 — worker ingest 용.
// GET /v2/myTrades (36시간 제한 — 자주 poll 해야 전체 history 수집 가능)
// Auth: HMAC-SHA256 + X-KAPI-KEY

import crypto from 'node:crypto';

const KORBIT_API = 'https://api.korbit.co.kr';

function signKorbit(secret: string, params: URLSearchParams): string {
  return crypto
    .createHmac('sha256', secret)
    .update(params.toString(), 'utf-8')
    .digest('hex');
}

export type KorbitTrade = {
  orderId: string;
  symbol: string; // btc_krw
  side: 'buy' | 'sell';
  avgPrice: string;
  filledQty: string;
  filledAmt: string; // total KRW
  createdAt: string; // epoch ms string
  status: string;
};

export async function getKorbitMyTrades(
  symbol: string,
  since?: number,
): Promise<KorbitTrade[]> {
  const apiKey = process.env.KORBIT_API_KEY;
  const apiSecret = process.env.KORBIT_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error('KORBIT_API_KEY / KORBIT_API_SECRET not set');

  const params = new URLSearchParams({
    symbol,
    limit: '1000',
    timestamp: Date.now().toString(),
  });
  const signature = signKorbit(apiSecret, params);
  params.append('signature', signature);

  const res = await fetch(`${KORBIT_API}/v2/myTrades?${params}`, {
    headers: { 'X-KAPI-KEY': apiKey },
  });
  if (!res.ok) throw new Error(`코빗 myTrades ${res.status}: ${await res.text()}`);
  const trades = (await res.json()) as KorbitTrade[];

  if (!since) return trades;
  return trades.filter((t) => Number(t.createdAt) > since);
}
