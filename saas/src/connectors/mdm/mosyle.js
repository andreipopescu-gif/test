import { asList, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

const DEFAULT_BASE = 'https://businessapi.mosyle.com';

/**
 * Mosyle Business API — access token against /v1/devices.
 */
export const mosyleProvider = {
  key: 'mosyle',
  label: 'Mosyle',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Devices read'],
  auth: 'Mosyle Business access token (portal API token).',
  credentialFields: ['accessToken', 'baseUrl'],
  optionalCredentialFields: ['baseUrl'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const accessToken = requireFields(credentials, ['accessToken'], 'Mosyle').accessToken;
    const baseUrl = normalizeHttpsBase(credentials.baseUrl || DEFAULT_BASE);
    const devices = [];
    let page = 1;
    for (;;) {
      const payload = await readJson(fetchImpl, `${baseUrl}/v1/devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          accessToken,
          options: { page, page_size: 100 }
        })
      }, 'Mosyle');
      const batch = asList(payload?.response || payload, ['devices', 'rows', 'data', 'results']);
      devices.push(...batch);
      if (batch.length < 100) break;
      page += 1;
      if (page > 500) break;
    }
    return {
      devices: {
        source: 'mosyle',
        records: devices.map(toMosyleExportRow)
      }
    };
  }
};

export function toMosyleExportRow(device) {
  return rowFromPreset('mosyle', {
    serialNumber: device.serial_number || device.serialnumber || device.SerialNumber,
    assetTag: device.device_name || device.devicename || device.asset_tag,
    model: device.device_model || device.model,
    manufacturer: device.manufacturer || 'Apple',
    modelIdentifier: device.device_model || device.model_id,
    os: device.os || device.operating_system,
    osVersion: device.osversion || device.os_version,
    personEmail: device.userid || device.user_email || device.email,
    personName: device.username || device.user_name || device.assigned_user,
    enrolledAt: device.date_enrolled || device.enrollment_date,
    lastEnrolledAt: device.date_last_beat || device.last_checkin || device.last_seen,
    externalId: device.udid || device.deviceudid || device.id
  });
}
