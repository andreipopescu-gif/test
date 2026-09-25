import { asList, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

/**
 * NinjaOne — OAuth client credentials, then /v2/devices.
 */
export const ninjaoneProvider = {
  key: 'ninjaone',
  label: 'NinjaOne',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Monitoring'],
  auth: 'NinjaOne OAuth client credentials against your regional API host.',
  credentialFields: ['baseUrl', 'clientId', 'clientSecret'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const { baseUrl: rawBase, clientId, clientSecret } = requireFields(
      credentials,
      ['baseUrl', 'clientId', 'clientSecret'],
      'NinjaOne'
    );
    const baseUrl = normalizeHttpsBase(rawBase);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'monitoring'
    });
    const tokenPayload = await readJson(fetchImpl, `${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body
    }, 'NinjaOne auth');
    const token = tokenPayload.access_token;
    if (!token) {
      const error = new Error('NinjaOne auth response had no access_token.');
      error.status = 502;
      throw error;
    }
    const payload = await readJson(fetchImpl, `${baseUrl}/v2/devices`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    }, 'NinjaOne devices');
    const devices = asList(payload, ['devices', 'data', 'results']);
    return {
      devices: {
        source: 'ninjaone',
        records: devices.map(toNinjaOneExportRow)
      }
    };
  }
};

export function toNinjaOneExportRow(device) {
  const system = device.system || device;
  return rowFromPreset('ninjaone', {
    serialNumber: system.biosSerialNumber || system.serialNumber || device.serialNumber,
    assetTag: device.systemName || device.displayName || device.name,
    model: system.model || system.systemModel || device.model,
    manufacturer: system.manufacturer || system.vendor,
    modelIdentifier: system.model,
    os: device.os?.name || system.osName || device.operatingSystem,
    osVersion: device.os?.version || system.osVersion,
    personEmail: device.ownerEmail || device.userEmail,
    personName: device.ownerName || device.userName,
    enrolledAt: device.created || device.creationTime,
    lastEnrolledAt: device.lastContact || device.lastUpdate,
    externalId: String(device.id || device.deviceId || device.nodeId || '')
  });
}
