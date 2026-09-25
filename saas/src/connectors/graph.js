/**
 * Shared Microsoft Graph client-credentials helpers (Entra + Intune).
 */

export const DEFAULT_LOGIN = 'https://login.microsoftonline.com';
export const DEFAULT_GRAPH = 'https://graph.microsoft.com';

export async function getGraphAccessToken({
  fetchImpl = globalThis.fetch,
  loginBase = DEFAULT_LOGIN,
  tenantId,
  clientId,
  clientSecret,
  label = 'Graph token'
} = {}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const response = await fetchImpl(`${trimSlash(loginBase)}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(graphErrorMessage(label, response.status, text));
    error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const error = new Error(`${label} response was not JSON.`);
    error.status = 502;
    throw error;
  }
  if (!json.access_token) {
    const error = new Error(`${label} response had no access_token.`);
    error.status = 502;
    throw error;
  }
  return json.access_token;
}

export async function graphGetAll(fetchImpl, accessToken, url, label = 'Microsoft Graph') {
  const items = [];
  let next = url;
  while (next) {
    const response = await fetchImpl(next, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(graphErrorMessage(label, response.status, text));
      error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
      throw error;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const error = new Error(`${label} response was not JSON.`);
      error.status = 502;
      throw error;
    }
    items.push(...(json.value || []));
    next = json['@odata.nextLink'] || '';
  }
  return items;
}

export function graphErrorMessage(label, status, text) {
  let detail = String(text || '').slice(0, 300);
  try {
    const json = JSON.parse(text);
    detail = json.error_description || json.error?.message || json.error || detail;
  } catch {
    // keep truncated body
  }
  return `${label} request failed (${status}): ${detail}`;
}

export function clean(value) {
  return String(value ?? '').trim();
}

export function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function requireGraphCredentials(credentials = {}, label = 'Graph') {
  const tenantId = clean(credentials.tenantId);
  const clientId = clean(credentials.clientId);
  const clientSecret = clean(credentials.clientSecret);
  if (!tenantId || !clientId || !clientSecret) {
    const error = new Error(`${label} credentials require tenantId, clientId and clientSecret.`);
    error.status = 400;
    throw error;
  }
  return { tenantId, clientId, clientSecret };
}
