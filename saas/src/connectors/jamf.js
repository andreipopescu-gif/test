/**
 * Live Jamf Pro connector (Classic API computers).
 *
 * Records match the Jamf CSV / demo connector headers so sync and file import
 * share the same mapper and exception rules.
 */

import { clean, trimSlash } from './graph.js';

export const jamfProvider = {
  key: 'jamf',
  label: 'Jamf Pro',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Read Computers'],
  auth: 'Jamf Pro API client (client credentials) with a read-only role on computers.',
  credentialFields: ['baseUrl', 'clientId', 'clientSecret'],
  async fetch({ credentials = {}, config = {}, fetchImpl = globalThis.fetch } = {}) {
    void config;
    const baseUrl = normalizeJamfBaseUrl(credentials.baseUrl);
    const clientId = clean(credentials.clientId);
    const clientSecret = clean(credentials.clientSecret);
    if (!baseUrl || !clientId || !clientSecret) {
      const error = new Error('Jamf credentials require baseUrl, clientId and clientSecret.');
      error.status = 400;
      throw error;
    }

    const authHeader = await getJamfAuthHeader({ fetchImpl, baseUrl, clientId, clientSecret });
    const list = await jamfJson(fetchImpl, `${baseUrl}/JSSResource/computers`, authHeader, 'Jamf computer list');
    const computers = list.computers || [];
    const records = [];
    for (const item of computers) {
      const id = item.id;
      if (!id) continue;
      try {
        const detail = await jamfJson(
          fetchImpl,
          `${baseUrl}/JSSResource/computers/id/${encodeURIComponent(id)}`,
          authHeader,
          `Jamf computer ${id}`
        );
        records.push(toJamfExportRow(detail.computer || {}, id));
      } catch (error) {
        // One bad computer must not abort the whole sync.
        if (error.status === 401 || error.status === 403) throw error;
      }
    }

    return {
      devices: {
        source: 'jamf',
        records
      }
    };
  }
};

export function toJamfExportRow(computer, fallbackId = '') {
  const general = computer.general || {};
  const hardware = computer.hardware || {};
  const location = computer.location || {};
  const lastCheckIn = general.report_date_utc
    || general.last_contact_time_utc
    || general.last_contact_time
    || general.report_date
    || '';
  return {
    'Computer Name': clean(general.name),
    'Serial Number': clean(general.serial_number),
    Make: clean(hardware.make),
    Model: clean(hardware.model),
    'Model Identifier': clean(hardware.model_identifier),
    'Asset Tag': clean(general.asset_tag),
    Username: clean(location.username),
    'Full Name': clean(location.realname),
    'Email Address': clean(location.email_address),
    Department: clean(location.department),
    'Operating System': clean(hardware.os_name),
    'Operating System Version': clean(hardware.os_version),
    'Total RAM MB': clean(hardware.total_ram_mb || hardware.total_ram),
    'Jamf Pro Computer ID': clean(general.id || fallbackId),
    'Initial Entry Date': clean(general.initial_entry_date_utc || general.initial_entry_date),
    'Last Enrollment Date': clean(general.last_enrolled_date_utc || general.last_enrolled_date),
    'Last Check-in': clean(lastCheckIn)
  };
}

export function normalizeJamfBaseUrl(value) {
  const raw = clean(value).replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    const error = new Error('Jamf baseUrl must be a valid http(s) URL.');
    error.status = 400;
    throw error;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    const error = new Error('Jamf baseUrl must use http or https.');
    error.status = 400;
    throw error;
  }
  // Block obvious SSRF targets in production; tests use loopback over http.
  const host = url.hostname.toLowerCase();
  const allowInsecure = process.env.SAAS_JAMF_ALLOW_INSECURE === '1'
    || host === '127.0.0.1'
    || host === 'localhost';
  if (url.protocol === 'http:' && !allowInsecure) {
    const error = new Error('Jamf baseUrl must use https.');
    error.status = 400;
    throw error;
  }
  return trimSlash(url.toString());
}

async function getJamfAuthHeader({ fetchImpl, baseUrl, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret
  });
  const response = await fetchImpl(`${baseUrl}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(jamfErrorMessage('Jamf OAuth', response.status, text));
    error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const error = new Error('Jamf OAuth response was not JSON.');
    error.status = 502;
    throw error;
  }
  if (!json.access_token) {
    const error = new Error('Jamf OAuth response had no access_token.');
    error.status = 502;
    throw error;
  }
  return { Authorization: `Bearer ${json.access_token}` };
}

async function jamfJson(fetchImpl, url, authHeader, label) {
  const response = await fetchImpl(url, {
    headers: { ...authHeader, Accept: 'application/json' }
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(jamfErrorMessage(label, response.status, text));
    error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`${label} response was not JSON.`);
    error.status = 502;
    throw error;
  }
}

function jamfErrorMessage(label, status, text) {
  let detail = String(text || '').slice(0, 300);
  try {
    const json = JSON.parse(text);
    detail = json.error_description || json.error || json.httpStatus || detail;
  } catch {
    // keep truncated body
  }
  return `${label} request failed (${status}): ${detail}`;
}
