import { asList, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

const DEFAULT_BASE = 'https://prod.addigy.com';

/**
 * Addigy — client credentials token, then devices list.
 */
export const addigyProvider = {
  key: 'addigy',
  label: 'Addigy',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Devices read'],
  auth: 'Addigy API client id and secret.',
  credentialFields: ['clientId', 'clientSecret', 'baseUrl'],
  optionalCredentialFields: ['baseUrl'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const { clientId, clientSecret } = requireFields(credentials, ['clientId', 'clientSecret'], 'Addigy');
    const baseUrl = normalizeHttpsBase(credentials.baseUrl || DEFAULT_BASE);
    const tokenPayload = await readJson(fetchImpl, `${baseUrl}/api/auth/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`, {
      method: 'POST',
      headers: { Accept: 'application/json' }
    }, 'Addigy auth');
    const token = tokenPayload.access_token || tokenPayload.token || tokenPayload.accessToken;
    if (!token) {
      const error = new Error('Addigy auth response had no access token.');
      error.status = 502;
      throw error;
    }
    const payload = await readJson(fetchImpl, `${baseUrl}/api/devices`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    }, 'Addigy devices');
    const devices = asList(payload, ['devices', 'data', 'results', 'items']);
    return {
      devices: {
        source: 'addigy',
        records: devices.map(toAddigyExportRow)
      }
    };
  }
};

export function toAddigyExportRow(device) {
  return rowFromPreset('addigy', {
    serialNumber: device.serial_number || device.serialNumber,
    assetTag: device.device_name || device.computer_name || device.name,
    model: device.model || device.hardware_model,
    manufacturer: device.manufacturer || 'Apple',
    modelIdentifier: device.model_identifier || device.model_id,
    os: device.os_version || device.operating_system || 'macOS',
    osVersion: device.os_version,
    personEmail: device.user_email || device.primary_user_email,
    personName: device.user_name || device.primary_user,
    enrolledAt: device.enrollment_date || device.created_at,
    lastEnrolledAt: device.last_check_in || device.last_contact,
    externalId: device.agentid || device.agent_id || device.device_id || device.id
  });
}
