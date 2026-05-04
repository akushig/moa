// Binance signed REST 호출용 공통 헬퍼. Vercel function (icn1 region) 에서 직접
// 호출 — 워커 us-west1 IP 가 HTTP 451 차단당해서 분리됨.
import crypto from 'node:crypto';

export const BINANCE_API = 'https://api.binance.com';

function sign(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export async function binanceAuthFetch(
  path: string,
  query: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
): Promise<Response> {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_SECRET_KEY;
  if (!apiKey || !secret) throw new Error('BINANCE_API_KEY / BINANCE_SECRET_KEY not set');
  const q: Record<string, string> = { ...query, timestamp: String(Date.now()), recvWindow: '10000' };
  const qs = new URLSearchParams(q).toString();
  const signature = sign(secret, qs);
  // Binance signed POST: 파라미터 query string (body 비움). signature 도 query 포함.
  return fetch(`${BINANCE_API}${path}?${qs}&signature=${signature}`, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey },
    cache: 'no-store',
  });
}
