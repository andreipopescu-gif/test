const intuneHeaders = [
  'Device ID',
  'Device name',
  'Management name',
  'Serial number',
  'Primary user UPN',
  'Primary user display name',
  'Last check-in'
];

const jamfHeaders = [
  'Computer Name',
  'Serial Number',
  'Model Identifier',
  'Jamf Pro Computer ID',
  'Full Name',
  'Email Address',
  'Total RAM MB'
];

export function detectSource(headers, requestedSource = 'auto') {
  if (requestedSource && requestedSource !== 'auto') return requestedSource;
  const headerSet = new Set(headers.map((header) => header.toLowerCase()));
  const intuneScore = intuneHeaders.filter((header) => headerSet.has(header.toLowerCase())).length;
  const jamfScore = jamfHeaders.filter((header) => headerSet.has(header.toLowerCase())).length;
  if (intuneScore >= 3 && intuneScore >= jamfScore) return 'intune';
  if (jamfScore >= 3) return 'jamf';
  throw new Error('Nu pot detecta sursa CSV. Alege manual Intune sau Jamf.');
}
