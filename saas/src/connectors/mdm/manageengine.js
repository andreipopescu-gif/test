import { asList, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

/**
 * ManageEngine Endpoint Central — API key / auth token against DC server.
 * Works for on-prem and many cloud setups that expose /api/1.4 inventory.
 */
export const manageengineProvider = {
  key: 'manageengine',
  label: 'ManageEngine Endpoint Central',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Inventory read'],
  auth: 'Endpoint Central auth token (or API key) against your DC base URL.',
  credentialFields: ['baseUrl', 'apiKey'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const { baseUrl: rawBase, apiKey } = requireFields(credentials, ['baseUrl', 'apiKey'], 'ManageEngine');
    const baseUrl = normalizeHttpsBase(rawBase);
    const payload = await readJson(fetchImpl, `${baseUrl}/api/1.4/inventory/computers`, {
      headers: {
        Authorization: apiKey,
        Authtoken: apiKey,
        Accept: 'application/json'
      }
    }, 'ManageEngine');
    const devices = asList(payload, [
      'computers',
      'message_response',
      'ComputerList',
      'data',
      'results'
    ]);
    // Some builds nest under message_response.computers
    const nested = payload?.message_response?.computers;
    const list = devices.length ? devices : (Array.isArray(nested) ? nested : []);
    return {
      devices: {
        source: 'manageengine',
        records: list.map(toManageEngineExportRow)
      }
    };
  }
};

export function toManageEngineExportRow(device) {
  const computer = device.computer_summary || device.computer || device;
  return rowFromPreset('manageengine', {
    serialNumber: computer.serial_number || computer.serial_no || computer.service_tag,
    assetTag: computer.computer_name || computer.device_name || computer.asset_tag,
    model: computer.model || computer.system_model,
    manufacturer: computer.manufacturer || computer.vendor_name,
    modelIdentifier: computer.model,
    os: computer.os_name || computer.operating_system,
    osVersion: computer.os_version || computer.service_pack,
    personEmail: computer.email_address || computer.user_email,
    personName: computer.user_name || computer.logged_on_user,
    enrolledAt: computer.registered_time || computer.enrollment_date,
    lastEnrolledAt: computer.last_contact_time || computer.last_successful_scan,
    externalId: String(computer.resource_id || computer.device_id || computer.id || '')
  });
}
