import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// No fallback secret: a shared default would let anyone mint valid tokens for
// any organization on a deployment that merely forgot the variable.
const jwtSecret = () => {
  const secret = process.env.SAAS_JWT_SECRET;
  if (!secret) throw new Error('SAAS_JWT_SECRET is not set');
  if (process.env.NODE_ENV === 'production' && secret.length < 32) {
    throw new Error('SAAS_JWT_SECRET must be at least 32 characters in production');
  }
  return secret;
};

// scrypt parameters travel with the hash so cost can rise over time without
// invalidating existing passwords. Legacy rows are `salt:hash` at N=16384.
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64, SCRYPT).toString('hex');
  return `${salt}:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  let salt;
  let hash;
  let options = { N: 16_384, r: 8, p: 1, maxmem: SCRYPT.maxmem };
  if (parts.length === 2) {
    [salt, hash] = parts;
  } else if (parts.length === 5) {
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    salt = parts[0];
    hash = parts[4];
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    options = { N: n, r, p, maxmem: SCRYPT.maxmem };
  } else {
    return false;
  }
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 64, options).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(next, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signToken(payload, expiresInSec = 60 * 60 * 12) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + expiresInSec
  }));
  const sig = b64url(createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64url(createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function b64url(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buf.toString('base64url');
}
