import { describe, it, expect } from 'vitest';
import { jwtVerify } from 'jose';
import crypto from 'node:crypto';
import { signUpbitJWT } from '@/lib/exchanges/upbit';

const ACCESS = 'test-access-key-12345';
const SECRET = 'test-secret-key-67890-must-be-long-enough';

describe('signUpbitJWT', () => {
  it('produces a valid HS256 JWT with access_key and nonce', async () => {
    const jwt = await signUpbitJWT(ACCESS, SECRET);
    const { payload, protectedHeader } = await jwtVerify(jwt, new TextEncoder().encode(SECRET));
    expect(protectedHeader.alg).toBe('HS256');
    expect(payload.access_key).toBe(ACCESS);
    expect(typeof payload.nonce).toBe('string');
    expect(payload.query_hash).toBeUndefined();
  });

  it('includes SHA512 query_hash when query is provided', async () => {
    const query = { state: 'wait', uuids: 'abc,def' };
    const jwt = await signUpbitJWT(ACCESS, SECRET, query);
    const { payload } = await jwtVerify(jwt, new TextEncoder().encode(SECRET));

    const expected = crypto
      .createHash('sha512')
      .update(new URLSearchParams(query).toString())
      .digest('hex');

    expect(payload.query_hash).toBe(expected);
    expect(payload.query_hash_alg).toBe('SHA512');
  });

  it('omits query_hash when query is empty object', async () => {
    const jwt = await signUpbitJWT(ACCESS, SECRET, {});
    const { payload } = await jwtVerify(jwt, new TextEncoder().encode(SECRET));
    expect(payload.query_hash).toBeUndefined();
  });

  it('produces a different nonce on each call', async () => {
    const a = await signUpbitJWT(ACCESS, SECRET);
    const b = await signUpbitJWT(ACCESS, SECRET);
    const pa = await jwtVerify(a, new TextEncoder().encode(SECRET));
    const pb = await jwtVerify(b, new TextEncoder().encode(SECRET));
    expect(pa.payload.nonce).not.toBe(pb.payload.nonce);
  });
});
