import { normalizeImportDate } from './date-utils.js';
import { parsePersonDisplayName } from '../utils/person-name.js';

export function mapJamfRows(records, deviceFilter = 'all') {
  return records.map(mapRow).filter((row) => row && matchesFilter(deviceFilter));
}

function mapRow(record) {
  const serialNumber = field(record, 'Serial Number');
  if (!serialNumber && !field(record, 'Jamf Pro Computer ID')) return null;
  const fullName = field(record, 'Full Name');
  const email = field(record, 'Email Address');
  const username = field(record, 'Username');
  const names = parsePersonDisplayName(fullName || username || email);

  return {
    source: 'jamf',
    line: record.__line,
    externalId: field(record, 'Jamf Pro Computer ID'),
    assetTag: field(record, 'Asset Tag') || field(record, 'Computer Name') || serialNumber,
    serialNumber,
    manufacturer: field(record, 'Make') || 'Apple',
    model: field(record, 'Model'),
    modelIdentifier: field(record, 'Model Identifier'),
    os: field(record, 'Operating System') || 'macOS',
    osVersion: field(record, 'Operating System Version'),
    ram: mbToGb(field(record, 'Total RAM MB')),
    lastSeen: field(record, 'Last Check-in') || field(record, 'Last Inventory Update'),
    enrolledAt: normalizeImportDate(field(record, [
      'Initial Entry Date',
      'Management Service Enrolled Date',
      'Enrollment Date',
      'Enrolled Date'
    ])),
    lastEnrolledAt: normalizeImportDate(field(record, [
      'Last Enrollment Date',
      'Last Enrolled Date',
      'Last enrollment date'
    ])),
    person: email || fullName || username
      ? {
          email,
          displayName: fullName || username || email,
          firstName: names.firstName,
          lastName: names.lastName,
          department: field(record, 'Department') || names.department || '',
          role: field(record, 'Position'),
          externalIds: { upn: email, jamfUsername: username }
        }
      : null,
    raw: record
  };
}

function matchesFilter(deviceFilter) {
  return deviceFilter === 'all' || deviceFilter === 'laptops' || deviceFilter === 'macbooks';
}

function field(record, name) {
  return record[name] ?? '';
}

function mbToGb(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return number ? `${Math.round(number / 1024)} GB` : '';
}
