/**
 * Live Microsoft Entra ID connector (Graph client credentials).
 *
 * Records are shaped like the Entra CSV export / demo connector so sync and
 * file import stay on the same mapper and exception path.
 */

const DEFAULT_LOGIN = 'https://login.microsoftonline.com';
const DEFAULT_GRAPH = 'https://graph.microsoft.com';
const USER_SELECT = [
  'id',
  'displayName',
  'givenName',
  'surname',
  'mail',
  'userPrincipalName',
  'jobTitle',
  'department',
  'officeLocation',
  'accountEnabled',
  'mobilePhone',
  'businessPhones'
].join(',');

export const entraProvider = {
  key: 'entra',
  label: 'Microsoft Entra ID',
  live: true,
  datasets: ['users'],
  requiredScopes: ['User.Read.All'],
  auth: 'OAuth 2.0 admin consent (client credentials); no passwords are stored.',
  credentialFields: ['tenantId', 'clientId', 'clientSecret'],
  async fetch({ credentials = {}, config = {}, fetchImpl = globalThis.fetch } = {}) {
    const tenantId = clean(credentials.tenantId);
    const clientId = clean(credentials.clientId);
    const clientSecret = clean(credentials.clientSecret);
    if (!tenantId || !clientId || !clientSecret) {
      const error = new Error('Entra credentials require tenantId, clientId and clientSecret.');
      error.status = 400;
      throw error;
    }

    // Test-only env overrides point at a local mock Graph; never accept host
    // overrides from stored connection config (SSRF).
    void config;
    const loginBase = trimSlash(process.env.SAAS_GRAPH_LOGIN_URL || DEFAULT_LOGIN);
    const graphBase = trimSlash(process.env.SAAS_GRAPH_BASE_URL || DEFAULT_GRAPH);
    const token = await getAccessToken({
      fetchImpl,
      loginBase,
      tenantId,
      clientId,
      clientSecret
    });
    const users = await graphGetAll(
      fetchImpl,
      token,
      `${graphBase}/v1.0/users?$select=${USER_SELECT}&$expand=manager($select=displayName,mail,userPrincipalName)&$top=999`
    );

    return {
      users: {
        source: 'entra',
        records: users.map(toEntraExportRow)
      }
    };
  }
};

export function toEntraExportRow(user) {
  const manager = user?.manager || {};
  const businessPhone = Array.isArray(user?.businessPhones) ? user.businessPhones[0] : '';
  return {
    'User principal name': clean(user?.userPrincipalName),
    Mail: clean(user?.mail) || clean(user?.userPrincipalName),
    'Display name': clean(user?.displayName),
    'First name': clean(user?.givenName),
    'Last name': clean(user?.surname),
    Department: clean(user?.department),
    'Job title': clean(user?.jobTitle),
    'Account enabled': user?.accountEnabled === false ? 'No' : 'Yes',
    Manager: clean(manager.displayName) || clean(manager.mail) || clean(manager.userPrincipalName),
    'Office location': clean(user?.officeLocation),
    'Mobile phone': clean(user?.mobilePhone) || clean(businessPhone),
    'Object Id': clean(user?.id)
  };
}

async function getAccessToken({ fetchImpl, loginBase, tenantId, clientId, clientSecret }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const response = await fetchImpl(`${loginBase}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(graphErrorMessage('Entra token', response.status, text));
    error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const error = new Error('Entra token response was not JSON.');
    error.status = 502;
    throw error;
  }
  if (!json.access_token) {
    const error = new Error('Entra token response had no access_token.');
    error.status = 502;
    throw error;
  }
  return json.access_token;
}

async function graphGetAll(fetchImpl, accessToken, url) {
  const items = [];
  let next = url;
  while (next) {
    const response = await fetchImpl(next, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(graphErrorMessage('Microsoft Graph', response.status, text));
      error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
      throw error;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const error = new Error('Microsoft Graph response was not JSON.');
      error.status = 502;
      throw error;
    }
    items.push(...(json.value || []));
    next = json['@odata.nextLink'] || '';
  }
  return items;
}

function graphErrorMessage(label, status, text) {
  let detail = text.slice(0, 300);
  try {
    const json = JSON.parse(text);
    detail = json.error_description || json.error?.message || json.error || detail;
  } catch {
    // keep truncated body
  }
  return `${label} request failed (${status}): ${detail}`;
}

function clean(value) {
  return String(value ?? '').trim();
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}
