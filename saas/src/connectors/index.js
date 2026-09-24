import { entraProvider } from './entra.js';
import { mockProvider } from './mock.js';

/**
 * Every provider hands back records shaped like that provider's CSV export,
 * so a live sync goes through exactly the same preview, apply and exception
 * pipeline as an uploaded file.
 */
const jamfProvider = {
  key: 'jamf',
  label: 'Jamf Pro',
  live: true,
  datasets: ['devices'],
  requiredScopes: ['Read Computers', 'Read Mobile Devices', 'Read Users'],
  auth: 'Jamf Pro API client (client credentials) with a read-only API role.',
  credentialFields: ['baseUrl', 'clientId', 'clientSecret'],
  async fetch() {
    throw notImplemented('Jamf Pro');
  }
};

export const PROVIDERS = [entraProvider, jamfProvider, mockProvider];

export function getProvider(key) {
  return PROVIDERS.find((provider) => provider.key === key) || null;
}

export function describeProvider(provider) {
  return {
    key: provider.key,
    label: provider.label,
    live: provider.live,
    datasets: provider.datasets,
    requiredScopes: provider.requiredScopes,
    auth: provider.auth || '',
    credentialFields: provider.credentialFields
  };
}

export function recordsToCsv(records) {
  const headers = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const cell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [headers.map(cell).join(',')];
  for (const record of records) lines.push(headers.map((header) => cell(record[header])).join(','));
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

function notImplemented(name) {
  const error = new Error(`${name} live sync is not available yet. Use CSV import or the demo connector.`);
  error.status = 501;
  return error;
}
