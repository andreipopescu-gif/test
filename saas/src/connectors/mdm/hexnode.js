import { asList, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

/**
 * Hexnode UEM — API key against portal subdomain host.
 */
export const hexnodeProvider = {
  key: 'hexnode',
  label: 'Hexnode UEM',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Devices read'],
  auth: 'Hexnode API key against your portal URL.',
  credentialFields: ['baseUrl', 'apiKey'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const { baseUrl: rawBase, apiKey } = requireFields(credentials, ['baseUrl', 'apiKey'], 'Hexnode');
    const baseUrl = normalizeHttpsBase(rawBase);
    const devices = [];
    let page = 1;
    for (;;) {
      const payload = await readJson(fetchImpl, `${baseUrl}/api/v1/devices/?per_page=100&page=${page}`, {
        headers: {
          Authorization: apiKey,
          Accept: 'application/json'
        }
      }, 'Hexnode');
      const batch = asList(payload, ['results', 'devices', 'data']);
      devices.push(...batch);
      if (batch.length < 100 || !payload?.next) break;
      page += 1;
      if (page > 500) break;
    }
    return {
      devices: {
        source: 'hexnode',
        records: devices.map(toHexnodeExportRow)
      }
    };
  }
};

export function toHexnodeExportRow(device) {
  const user = device.user || device.enrolled_user || {};
  return rowFromPreset('hexnode', {
    serialNumber: device.serial_number || device.serialnumber,
    assetTag: device.device_name || device.name || device.asset_tag,
    model: device.model_name || device.model,
    manufacturer: device.manufacturer || device.vendor,
    modelIdentifier: device.model_name || device.product_name,
    os: device.os_name || device.platform || device.os,
    osVersion: device.os_version || device.platform_version,
    personEmail: user.email || device.user_email || device.email,
    personName: user.name || device.user_name || device.username,
    enrolledAt: device.enrolled_time || device.enrollment_date,
    lastEnrolledAt: device.last_reported || device.last_seen,
    externalId: device.id || device.device_id || device.udid
  });
}
