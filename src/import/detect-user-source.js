const entraUserHeaders = [
  'User principal name',
  'Display name',
  'Department',
  'Job title',
  'Object Id',
  'Mail'
];

const intuneDeviceHeaders = [
  'Device ID',
  'Serial number',
  'Primary user UPN',
  'Primary user display name'
];

export function detectUserSource(headers, requestedSource = 'auto') {
  if (requestedSource === 'entra') return 'entra';
  if (requestedSource === 'intune_users') return 'intune_users';

  const headerSet = new Set(headers.map((header) => header.toLowerCase()));
  const entraScore = entraUserHeaders.filter((header) => headerSet.has(header.toLowerCase())).length;
  const intuneScore = intuneDeviceHeaders.filter((header) => headerSet.has(header.toLowerCase())).length;
  const hasSerial = headerSet.has('serial number') || headerSet.has('device id');

  if (entraScore >= 2 && !hasSerial) return 'entra';
  if (hasSerial && intuneScore >= 2) return 'intune_users';
  if (headerSet.has('user principal name') && (headerSet.has('department') || headerSet.has('job title'))) return 'entra';
  if (hasSerial) return 'intune_users';
  throw new Error('Nu pot detecta sursa CSV pentru utilizatori. Alege Entra sau Intune.');
}
