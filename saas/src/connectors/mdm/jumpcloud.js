import { asList, normalizeHttpsBase, readJson, requireFields, rowFromPreset } from './util.js';

const DEFAULT_BASE = 'https://console.jumpcloud.com';

/**
 * JumpCloud systems inventory via x-api-key.
 */
export const jumpcloudProvider = {
  key: 'jumpcloud',
  label: 'JumpCloud',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Read Systems'],
  auth: 'JumpCloud API key (x-api-key header).',
  credentialFields: ['apiKey', 'baseUrl'],
  optionalCredentialFields: ['baseUrl'],
  async fetch({ credentials = {}, fetchImpl = globalThis.fetch } = {}) {
    const apiKey = requireFields(credentials, ['apiKey'], 'JumpCloud').apiKey;
    const baseUrl = normalizeHttpsBase(credentials.baseUrl || DEFAULT_BASE);
    const systems = [];
    let skip = 0;
    const limit = 100;
    for (;;) {
      const payload = await readJson(fetchImpl, `${baseUrl}/api/systems?limit=${limit}&skip=${skip}`, {
        headers: {
          'x-api-key': apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      }, 'JumpCloud');
      const batch = asList(payload, ['results', 'systems', 'data']);
      systems.push(...batch);
      if (batch.length < limit) break;
      skip += batch.length;
      if (skip > 50_000) break;
    }
    return {
      devices: {
        source: 'jumpcloud',
        records: systems.map(toJumpCloudExportRow)
      }
    };
  }
};

export function toJumpCloudExportRow(system) {
  return rowFromPreset('jumpcloud', {
    serialNumber: system.serialNumber || system.serial_number,
    assetTag: system.displayName || system.hostname || system.systemHostname,
    model: system.hardwareModel || system.model,
    manufacturer: system.manufacturer || system.vendor,
    modelIdentifier: system.modelIdentifier || system.hardwareModel,
    os: system.os || system.operatingSystem,
    osVersion: system.version || system.osVersion,
    personEmail: system.primaryUserEmail || system.userEmail,
    personName: system.primaryUser || system.userName,
    enrolledAt: system.created || system.enrollmentDate,
    lastEnrolledAt: system.lastContact || system.lastContactTime || system.lastSeen,
    externalId: system.id || system._id || system.systemId
  });
}
