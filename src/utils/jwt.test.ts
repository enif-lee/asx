import { describe, it, expect } from 'vitest';
import { decodeJwtClaims } from './jwt.js';

const b64url = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: any) => `${b64url({ alg: 'none' })}.${b64url(claims)}.sig`;

describe('decodeJwtClaims', () => {
  it('decodes a payload', () => {
    expect(decodeJwtClaims(jwt({ email: 'a@b.c', exp: 42 }))).toEqual({ email: 'a@b.c', exp: 42 });
  });
  it('handles payloads whose base64url length is not a multiple of 4 (padding)', () => {
    // pick a claim set whose encoded length % 4 !== 0 to exercise padding tolerance
    const claims = { sub: 'x' };
    const payload = b64url(claims);
    expect(payload.length % 4).not.toBe(0);
    expect(decodeJwtClaims(jwt(claims))).toEqual(claims);
  });
  it('returns null for junk / missing / single-segment tokens', () => {
    expect(decodeJwtClaims('not-a-jwt')).toBeNull();
    expect(decodeJwtClaims('')).toBeNull();
    expect(decodeJwtClaims(undefined)).toBeNull();
    expect(decodeJwtClaims('a.b.c')).toBeNull(); // b is not valid JSON
  });
});
