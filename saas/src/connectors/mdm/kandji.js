import { asList, clean, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

/**
 * Kandji — Bearer API token against the tenant API host.
 * Docs shape: GET /api/v1/devices
 */
export const kandjiProvider = {
  key: 'kandji',
  label: 'Kandji',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Device list', 'Device details'],
  auth: 'Kandji API token (Bearer) against your tenant API URL.',
  credentialFields: ['baseUrl', 'apiToken'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const { baseUrl: rawBase, apiToken } = requireFields(credentials, ['baseUrl', 'apiToken'], 'Kandji');
    const baseUrl = normalizeHttpsBase(rawBase);
    const devices = [];
    let offset = 0;
    const limit = 300;
    for (;;) {
      const url = `${baseUrl}/api/v1/devices?limit=${limit}&offset=${offset}`;
      const payload = await readJson(fetchImpl, url, {
        headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' }
      }, 'Kandji');
      const batch = asList(payload, ['devices', 'data', 'results']);
      // Some tenants return a bare array.
      const rows = batch.length ? batch : (Array.isArray(payload) ? payload : []);
      devices.push(...rows);
      if (rows.length < limit) break;
      offset += rows.length;
      if (offset > 50_000) break;
    }
    return {
      devices: {
        source: 'kandji',
        records: devices.map(toKandjiExportRow)
      }
    };
  }
};

export function toKandjiExportRow(device) {
  const user = device.user || device.assigned_user || {};
  return rowFromPreset('kandji', {
    serialNumber: device.serial_number || device.serialNumber,
    assetTag: device.asset_tag || device.device_name || device.name,
    model: device.model || device.model_name,
    manufacturer: device.manufacturer || device.make || 'Apple',
    modelIdentifier: device.model_identifier || device.hardware_model,
    os: device.platform || device.os_name || device.os,
    osVersion: device.os_version || device.osVersion,
    personEmail: user.email || device.user_email || device.email,
    personName: user.name || device.user_name || [user.first_name, user.last_name].filter(Boolean).join(' '),
    enrolledAt: device.first_enrollment_date || device.enrollment_date,
    lastEnrolledAt: device.last_check_in || device.last_enrollment_date || device.last_seen,
    externalId: device.device_id || device.id
  });
}
