import { parsePersonDisplayName } from '../utils/person-name.js';

export function mapIntuneUserRows(records) {
  const byKey = new Map();
  for (const record of records) {
    const person = extractPerson(record);
    if (!person) continue;
    const key = (person.email || person.externalIds.upn).toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, person);
      continue;
    }
    mergePerson(existing, person);
  }
  return [...byKey.values()];
}

function extractPerson(record) {
  const userName = field(record, [
    'Primary user display name',
    'Primary User Display Name',
    'Primary user',
    'User display name',
    'User Display Name',
    'UserName',
    'User name'
  ]);
  const email = field(record, [
    'Primary user UPN',
    'Primary User UPN',
    'Primary user email address',
    'Primary User Email Address',
    'User principal name',
    'User Principal Name',
    'UPN',
    'UserEmail',
    'Email'
  ]);
  if (!email && !userName) return null;

  const names = parsePersonDisplayName(userName || email);
  return {
    source: 'intune_users',
    line: record.__line,
    email: email || userName,
    displayName: userName || email,
    firstName: names.firstName,
    lastName: names.lastName,
    department: field(record, ['Department', 'User department', 'User Department']) || names.department || '',
    role: field(record, ['Job title', 'Job Title', 'User job title', 'User Job Title']),
    phone: field(record, ['User phone', 'User Phone', 'Phone number', 'Phone Number']),
    manager: '',
    location: '',
    status: '',
    externalIds: {
      upn: email || userName,
      jamfUsername: '',
      entraObjectId: field(record, ['User ID', 'User Id', 'Azure AD Device ID', 'AAD user ID'])
    },
    raw: record
  };
}

function mergePerson(target, incoming) {
  for (const key of ['department', 'role', 'phone', 'displayName']) {
    if (!target[key] && incoming[key]) target[key] = incoming[key];
  }
  if ((!target.firstName || target.firstName === 'Necunoscut') && incoming.firstName) target.firstName = incoming.firstName;
  if ((!target.lastName || target.lastName === '-') && incoming.lastName) target.lastName = incoming.lastName;
  if (!target.externalIds.entraObjectId && incoming.externalIds.entraObjectId) {
    target.externalIds.entraObjectId = incoming.externalIds.entraObjectId;
  }
}

function field(record, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const value = record[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  const normalized = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [normalizeKey(key), value])
  );
  for (const name of list) {
    const value = normalized[normalizeKey(name)];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
