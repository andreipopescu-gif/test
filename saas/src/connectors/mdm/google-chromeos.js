import { createSign } from 'node:crypto';
import { asList, clean, readJson, requireFields, rowFromPreset } from './util.js';

/**
 * Google Admin ChromeOS devices via service-account JWT.
 * Scopes: https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly
 */
export const googleChromeOsProvider = {
  key: 'google_chromeos',
  label: 'Google Admin (ChromeOS)',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['admin.directory.device.chromeos.readonly'],
  auth: 'Google service account with domain-wide delegation (client email + private key + customer id).',
  credentialFields: ['customerId', 'clientEmail', 'privateKey', 'subject'],
  optionalCredentialFields: ['subject'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const creds = requireFields(
      credentials,
      ['customerId', 'clientEmail', 'privateKey'],
      'Google ChromeOS'
    );
    const subject = clean(credentials.subject);
    const token = await getGoogleAccessToken({
      fetchImpl,
      clientEmail: creds.clientEmail,
      privateKey: normalizePrivateKey(creds.privateKey),
      subject,
      scope: 'https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly'
    });
    const devices = [];
    let pageToken = '';
    for (;;) {
      const query = new URLSearchParams({
        maxResults: '200',
        projection: 'FULL'
      });
      if (pageToken) query.set('pageToken', pageToken);
      const payload = await readJson(
        fetchImpl,
        `https://admin.googleapis.com/admin/directory/v1/customer/${encodeURIComponent(creds.customerId)}/devices/chromeos?${query}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
        'Google ChromeOS'
      );
      devices.push(...asList(payload, ['chromeosdevices', 'devices']));
      pageToken = payload.nextPageToken || '';
      if (!pageToken) break;
    }
    return {
      devices: {
        source: 'google_chromeos',
        records: devices.map(toGoogleChromeOsExportRow)
      }
    };
  }
};

export function toGoogleChromeOsExportRow(device) {
  const recent = Array.isArray(device.recentUsers) ? device.recentUsers[0] : null;
  return rowFromPreset('google_chromeos', {
    serialNumber: device.serialNumber,
    assetTag: device.annotatedAssetId || device.deviceId,
    model: device.model,
    manufacturer: device.manufacturer || 'Google',
    os: device.platformVersion || 'ChromeOS',
    osVersion: device.osVersion || device.platformVersion,
    personEmail: recent?.email || device.annotatedUser,
    personName: recent?.email || device.annotatedUser,
    enrolledAt: device.lastEnrollmentTime || device.firstEnrollmentTime,
    lastEnrolledAt: device.lastSync || device.lastEnrollmentTime,
    externalId: device.deviceId || device.chromeOsDeviceId
  });
}

function normalizePrivateKey(value) {
  return clean(value).replace(/\\n/g, '\n');
}

async function getGoogleAccessToken({ fetchImpl, clientEmail, privateKey, subject, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    ...(subject ? { sub: subject } : {})
  };
  const assertion = signJwt(claim, privateKey);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion
  });
  const payload = await readJson(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  }, 'Google token');
  if (!payload.access_token) {
    const error = new Error('Google token response had no access_token.');
    error.status = 502;
    throw error;
  }
  return payload.access_token;
}

function signJwt(payload, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encoded = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(encoded);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${encoded}.${base64url(signature)}`;
}

function base64url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
