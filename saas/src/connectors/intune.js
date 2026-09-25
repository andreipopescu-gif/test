/**
 * Live Microsoft Intune connector (Graph managed devices).
 *
 * Records match the Intune CSV export headers so sync and file import share
 * the same mapper and exception rules.
 */

import {
  DEFAULT_GRAPH,
  DEFAULT_LOGIN,
  clean,
  getGraphAccessToken,
  graphGetAll,
  requireGraphCredentials,
  trimSlash
} from './graph.js';

const DEVICE_SELECT = [
  'id',
  'deviceName',
  'managedDeviceName',
  'serialNumber',
  'manufacturer',
  'model',
  'operatingSystem',
  'osVersion',
  'imei',
  'userPrincipalName',
  'userDisplayName',
  'emailAddress',
  'deviceCategoryDisplayName',
  'lastSyncDateTime',
  'enrolledDateTime'
].join(',');

export const intuneProvider = {
  key: 'intune',
  label: 'Microsoft Intune',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['DeviceManagementManagedDevices.Read.All'],
  auth: 'OAuth 2.0 admin consent (client credentials); no passwords are stored.',
  credentialFields: ['tenantId', 'clientId', 'clientSecret'],
  async fetch({ credentials = {}, config = {}, fetchImpl = globalThis.fetch } = {}) {
    const { tenantId, clientId, clientSecret } = requireGraphCredentials(credentials, 'Intune');
    void config;
    const loginBase = trimSlash(process.env.SAAS_GRAPH_LOGIN_URL || DEFAULT_LOGIN);
    const graphBase = trimSlash(process.env.SAAS_GRAPH_BASE_URL || DEFAULT_GRAPH);
    const token = await getGraphAccessToken({
      fetchImpl,
      loginBase,
      tenantId,
      clientId,
      clientSecret,
      label: 'Intune token'
    });
    const devices = await graphGetAll(
      fetchImpl,
      token,
      `${graphBase}/v1.0/deviceManagement/managedDevices?$select=${DEVICE_SELECT}&$top=999`,
      'Intune Graph'
    );
    return {
      devices: {
        source: 'intune',
        records: devices.map(toIntuneExportRow)
      }
    };
  }
};

export function toIntuneExportRow(device) {
  return {
    'Device ID': clean(device?.id),
    'Device name': clean(device?.deviceName),
    'Management name': clean(device?.managedDeviceName),
    'Serial number': clean(device?.serialNumber),
    Manufacturer: clean(device?.manufacturer),
    Model: clean(device?.model),
    OS: clean(device?.operatingSystem),
    'OS version': clean(device?.osVersion),
    IMEI: clean(device?.imei),
    'Primary user UPN': clean(device?.userPrincipalName),
    'Primary user display name': clean(device?.userDisplayName),
    'Primary user email address': clean(device?.emailAddress),
    'Group tag': clean(device?.deviceCategoryDisplayName),
    'Last check-in': clean(device?.lastSyncDateTime),
    'Enrollment date': clean(device?.enrolledDateTime)
  };
}
