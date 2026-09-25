import { asList, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

/**
 * VMware Workspace ONE UEM — OAuth client credentials + aw-tenant-code.
 */
export const workspaceOneProvider = {
  key: 'workspace_one',
  label: 'Workspace ONE (UEM)',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Devices read'],
  auth: 'Workspace ONE OAuth client credentials with tenant code.',
  credentialFields: ['baseUrl', 'tenantCode', 'clientId', 'clientSecret'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const creds = requireFields(
      credentials,
      ['baseUrl', 'tenantCode', 'clientId', 'clientSecret'],
      'Workspace ONE'
    );
    const baseUrl = normalizeHttpsBase(creds.baseUrl);
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    const tokenPayload = await readJson(fetchImpl, `${baseUrl}/auth/token?grant_type=client_credentials`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'aw-tenant-code': creds.tenantCode,
        Accept: 'application/json'
      }
    }, 'Workspace ONE auth');
    const token = tokenPayload.access_token;
    if (!token) {
      const error = new Error('Workspace ONE auth response had no access_token.');
      error.status = 502;
      throw error;
    }
    const payload = await readJson(fetchImpl, `${baseUrl}/mdm/devices/search?page_size=500`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'aw-tenant-code': creds.tenantCode,
        Accept: 'application/json'
      }
    }, 'Workspace ONE devices');
    const devices = asList(payload, ['Devices', 'devices', 'data', 'results']);
    return {
      devices: {
        source: 'workspace_one',
        records: devices.map(toWorkspaceOneExportRow)
      }
    };
  }
};

export function toWorkspaceOneExportRow(device) {
  return rowFromPreset('workspace_one', {
    serialNumber: device.SerialNumber || device.serial_number || device.Serial,
    assetTag: device.DeviceFriendlyName || device.UserFriendlyName || device.AssetNumber,
    model: device.Model || device.ModelName,
    manufacturer: device.OEMInfo || device.Manufacturer,
    modelIdentifier: device.Model || device.HardwareIdentifier,
    os: device.Platform || device.OperatingSystem,
    osVersion: device.OperatingSystem || device.OSVersion,
    personEmail: device.UserEmailAddress || device.EmailAddress || device.EnrollmentUserEmail,
    personName: device.UserName || device.Owner || device.DisplayName,
    enrolledAt: device.LastEnrolledOn || device.EnrollmentDate,
    lastEnrolledAt: device.LastSeen || device.LastCheckInTime || device.LastCheckIn,
    externalId: String(device.Id?.Value || device.Uuid || device.DeviceId || device.Id || '')
  });
}
