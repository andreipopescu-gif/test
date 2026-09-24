#!/usr/bin/env node
/**
 * Save Entra client-credentials on a running instance and optionally sync.
 *
 * Env:
 *   TARGET_URL          default http://127.0.0.1:8090
 *   ADMIN_EMAIL         required
 *   ADMIN_PASSWORD      required
 *   ENTRA_TENANT_ID     required
 *   ENTRA_CLIENT_ID     required
 *   ENTRA_CLIENT_SECRET required
 *   SYNC                set to "1" to sync immediately after save
 */

const baseUrl = String(process.env.TARGET_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
const email = required('ADMIN_EMAIL');
const password = required('ADMIN_PASSWORD');
const tenantId = required('ENTRA_TENANT_ID');
const clientId = required('ENTRA_CLIENT_ID');
const clientSecret = required('ENTRA_CLIENT_SECRET');
const doSync = process.env.SYNC === '1';

const login = await api('POST', '/api/auth/login', {
  body: { email, password }
});
const saved = await api('PUT', '/api/connections/entra', {
  token: login.token,
  body: { credentials: { tenantId, clientId, clientSecret } }
});
console.log(`Saved Entra connection: status=${saved.connection?.status} hasCredentials=${saved.connection?.hasCredentials}`);

if (doSync) {
  const sync = await api('POST', '/api/connections/entra/sync', { token: login.token, body: {} });
  console.log(`Synced: users created=${sync.users?.created || 0} updated=${sync.users?.updated || 0}; open issues=${sync.exceptions?.open ?? 'n/a'}`);
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return value;
}

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`${method} ${path} → ${response.status}`, payload);
    process.exit(1);
  }
  return payload;
}
