import { parsePersonDisplayName, titleCasePersonName, looksLikeMalformedPersonName } from '../utils/person-name.js';
import { fieldIndex, normalizeKey } from './record-lookup.js';

export function mapEntraUserRows(records) {
  return records.map(mapRow).filter(Boolean);
}

function mapRow(record) {
  const upn = field(record, [
    'User principal name',
    'User Principal Name',
    'UPN',
    'Primary user UPN',
    'Primary User UPN'
  ]);
  const email = field(record, [
    'Mail',
    'Email',
    'E-mail',
    'Primary email address',
    'Primary Email Address',
    'Primary user email address'
  ]) || upn;
  if (!email && !upn) return null;

  const firstName = field(record, ['First name', 'First Name', 'Given name', 'Given Name']);
  const lastName = field(record, ['Last name', 'Last Name', 'Surname']);
  const displayName = field(record, ['Display name', 'Display Name', 'Name']);
  const names = resolveNames(firstName, lastName, displayName, email || upn);
  const status = parseAccountEnabled(field(record, [
    'Account enabled',
    'Account Enabled',
    'Enabled',
    'Sign-in blocked'
  ]));
  const department = field(record, ['Department', 'Dept']) || names.department || '';

  return {
    source: 'entra',
    line: record.__line,
    email: email || upn,
    displayName: displayName || `${names.firstName} ${names.lastName}`.trim(),
    firstName: names.firstName,
    lastName: names.lastName,
    department,
    role: field(record, ['Job title', 'Job Title', 'Title', 'Position']),
    phone: field(record, ['Mobile phone', 'Mobile Phone', 'Business phone', 'Business Phone', 'Phone']),
    manager: field(record, ['Manager', 'Manager display name', 'Manager Display Name']),
    location: field(record, ['Office location', 'Office Location', 'Office', 'City', 'Country']),
    status,
    externalIds: {
      upn: upn || email,
      jamfUsername: '',
      entraObjectId: field(record, ['Object Id', 'Object ID', 'Id', 'User object ID', 'Azure AD Object Id'])
    },
    raw: record
  };
}

function resolveNames(firstName, lastName, displayName, fallback) {
  if (firstName || lastName) {
    if (looksLikeMalformedPersonName(firstName, lastName)) {
      const fromCombined = parsePersonDisplayName(`${firstName || ''} ${lastName || ''}`.trim());
      if (displayName && looksLikeMalformedPersonName(fromCombined.firstName, fromCombined.lastName) === false) {
        return parsePersonDisplayName(displayName);
      }
      if (!looksLikeMalformedPersonName(fromCombined.firstName, fromCombined.lastName)) {
        return fromCombined;
      }
      if (displayName) return parsePersonDisplayName(displayName);
      return fromCombined;
    }
    return {
      firstName: titleCasePersonName(firstName || 'Necunoscut'),
      lastName: titleCasePersonName(lastName || '-'),
      department: ''
    };
  }
  if (displayName) return parsePersonDisplayName(displayName);
  return parsePersonDisplayName(String(fallback).replace(/@.+$/, '').replace(/[._-]+/g, ' '));
}

function parseAccountEnabled(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  if (['yes', 'true', '1', 'enabled'].includes(text)) return 'active';
  if (['no', 'false', '0', 'disabled', 'blocked'].includes(text)) return 'inactive';
  return '';
}

function field(record, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const value = record[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  const index = fieldIndex(record);
  for (const name of list) {
    const entry = index.get(normalizeKey(name));
    if (!entry) continue;
    const value = entry.last;
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}
