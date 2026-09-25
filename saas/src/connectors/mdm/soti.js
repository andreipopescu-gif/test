import { asList, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

/**
 * SOTI MobiControl — OAuth client credentials, then device search.
 */
export const sotiProvider = {
  key: 'soti',
  label: 'SOTI MobiControl',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Devices read'],
  auth: 'SOTI MobiControl OAuth client credentials.',
  credentialFields: ['baseUrl', 'clientId', 'clientSecret'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const { baseUrl: rawBase, clientId, clientSecret } = requireFields(
      credentials,
      ['baseUrl', 'clientId', 'clientSecret'],
      'SOTI'
    );
    const baseUrl = normalizeHttpsBase(rawBase);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });
    const tokenPayload = await readJson(fetchImpl, `${baseUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body
    }, 'SOTI auth');
    const token = tokenPayload.access_token;
    if (!token) {
      const error = new Error('SOTI auth response had no access_token.');
      error.status = 502;
      throw error;
    }
    const payload = await readJson(fetchImpl, `${baseUrl}/api/devices/search?take=1000`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    }, 'SOTI devices');
    const devices = asList(payload, ['devices', 'Devices', 'data', 'results', 'value']);
    return {
      devices: {
        source: 'soti',
        records: devices.map(toSotiExportRow)
      }
    };
  }
};

export function toSotiExportRow(device) {
  return rowFromPreset('soti', {
    serialNumber: device.SerialNumber || device.HardwareSerialNumber || device.Imei,
    assetTag: device.DeviceName || device.FriendlyName || device.Name,
    model: device.Model || device.HardwareModel,
    manufacturer: device.Manufacturer || device.OEM,
    modelIdentifier: device.Model,
    os: device.Platform || device.OperatingSystem || device.OSFamily,
    osVersion: device.OSVersion || device.PlatformVersion,
    personEmail: device.UserEmail || device.EnrollmentEmail || device.Email,
    personName: device.UserName || device.OwnerName,
    enrolledAt: device.EnrollmentTime || device.EnrollmentDate,
    lastEnrolledAt: device.LastCheckInTime || device.LastAgentConnectTime || device.LastSeen,
    imei: device.Imei || device.IMEI,
    externalId: String(device.DeviceId || device.Id || device.Guid || '')
  });
}
