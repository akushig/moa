import { describe, it, expect } from 'vitest';
import { jwtVerify } from 'jose';
import crypto from 'node:crypto';
import { signBithumbJWT } from '@/lib/exchanges/bithumb';

const ACCESS = 'bithumb-access-key-test-12345';
const SECRET = 'bithumb-secret-key-test-67890-must-be-long-enough';

describe('signBithumbJWT (v2)', () => {
  it('produces a valid HS256 JWT with access_key, nonce(UUID), timestamp', async () => {
    const before = Date.now();
    const jwt = await signBithumbJWT(ACCESS, SECRET);
    const after = Date.now();
    const { payload, protectedHeader } = await jwtVerify(jwt, new TextEncoder().encode(SECRET));
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.access_key).toBe(ACCESS);
    expect(typeof payload.nonce).toBe('string');
    expect(payload.nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof payload.timestamp).toBe('number');
    expect(payload.timestamp as number).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp as number).toBeLessThanOrEqual(after);
    expect(payload.query_hash).toBeUndefined();
  });

  it('includes SHA512 query_hash when query is provided', async () => {
    const query = { market: 'KRW-BTC', uuids: 'a,b' };
    const jwt = await signBithumbJWT(ACCESS, SECRET, query);
    const { payload } = await jwtVerify(jwt, new TextEncoder().encode(SECRET));
    const expected = crypto
      .createHash('sha512')
      .update(new URLSearchParams(query).toString())
      .digest('hex');
    expect(payload.query_hash).toBe(expected);
    expect(payload.query_hash_alg).toBe('SHA512');
  });

  it('produces a different nonce on each call', async () => {
    const a = await signBithumbJWT(ACCESS, SECRET);
    const b = await signBithumbJWT(ACCESS, SECRET);
    const pa = await jwtVerify(a, new TextEncoder().encode(SECRET));
    const pb = await jwtVerify(b, new TextEncoder().encode(SECRET));
    expect(pa.payload.nonce).not.toBe(pb.payload.nonce);
  });

  it('omits query_hash when query is empty object', async () => {
    const jwt = await signBithumbJWT(ACCESS, SECRET, {});
    const { payload } = await jwtVerify(jwt, new TextEncoder().encode(SECRET));
    expect(payload.query_hash).toBeUndefined();
  });
});
