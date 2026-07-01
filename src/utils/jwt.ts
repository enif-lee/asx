// Decode a JWT payload (claims) without verifying the signature. Returns null on
// anything malformed. Node's 'base64url' encoding handles padding, so no manual
// pad/replace dance (the old hand-rolled variants disagreed on padding).
export function decodeJwtClaims(token: string | undefined | null): any | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
