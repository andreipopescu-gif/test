import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Connector credentials (Graph client secrets, Jamf API clients) are stored
// encrypted with a key that never lives in the database. Without
// SAAS_CONNECTOR_KEY the server refuses to store credentials at all rather
// than falling back to something guessable.
function key() {
  const raw = String(process.env.SAAS_CONNECTOR_KEY || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return createHash('sha256').update(raw).digest();
}

export function canStoreCredentials() {
  return Boolean(key());
}

export function encryptCredentials(value) {
  const secret = key();
  if (!secret) {
    const error = new Error('SAAS_CONNECTOR_KEY is not configured; credentials cannot be stored.');
    error.status = 503;
    throw error;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value ?? {}), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${body.toString('base64')}`;
}

export function decryptCredentials(payload) {
  if (!payload) return {};
  const secret = key();
  if (!secret) {
    const error = new Error('SAAS_CONNECTOR_KEY is not configured; stored credentials cannot be read.');
    error.status = 503;
    throw error;
  }
  const [version, iv, tag, body] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognised credential payload');
  const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const text = Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(text);
}
