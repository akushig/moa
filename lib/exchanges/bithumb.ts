import { SignJWT } from 'jose';
import crypto from 'node:crypto';

// NOTE: Day 2 부터 Vercel 페이지는 거래소를 직접 호출하지 않는다.
// 실제 거래소 호출은 worker/src/exchanges/bithumb.ts (GCP VM) 에서 수행.
// 이 파일은 signBithumbJWT 단위 테스트 보존용.

// 빗썸 v2 JWT spec: payload = { access_key, nonce: uuid, timestamp: epoch ms,
// [query_hash, query_hash_alg] }, HS256, Authorization: Bearer.
export async function signBithumbJWT(
  accessKey: string,
  secretKey: string,
  query?: Record<string, string>,
): Promise<string> {
  const payload: Record<string, unknown> = {
    access_key: accessKey,
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
  };
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    payload.query_hash = crypto.createHash('sha512').update(qs).digest('hex');
    payload.query_hash_alg = 'SHA512';
  }
  const secret = new TextEncoder().encode(secretKey);
  return await new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).sign(secret);
}
