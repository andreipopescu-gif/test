import { normalizeImportDate } from './date-utils.js';
import { detectMtrRegion, shouldSkipImportedUser } from './excluded-users.js';
import { parsePersonDisplayName } from '../utils/person-name.js';

export function mapIntuneRows(records, deviceFilter = 'all') {
  return records.map(mapRow).filter((row) => row && matchesFilter(row, deviceFilter));
}

function mapRow(record) {
  const manufacturer = field(record, ['Manufacturer', 'Device manufacturer', 'Device Manufacturer', 'OEM']);
  let model = field(record, ['Model', 'Device model', 'Device Model', 'Model name', 'Device model name']);
  let os = field(record, [
    'OS',
    'Operating system',
    'Operating System',
    'Device operating system',
    'Device Operating System',
    'Platform',
    'Device platform',
    'DeviceType',
    'Device type'
  ]);
  os = inferOsIfMissing(os, manufacturer, model);
  const serialNumber = field(record, ['Serial number', 'Serial Number', 'Device serial number', 'Device Serial Number']);
  const userName = field(record, [
    'Primary user display name',
    'Primary User Display Name',
    'Primary user',
    'Primary User',
    'User display name',
    'User Display Name',
    'UserName',
    'User name',
    'User Name'
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
    'User email',
    'Email'
  ]);
  const assetTag = field(record, ['Device name', 'Device Name', 'Management name', 'Management Name']) || serialNumber;
  const groupTag = field(record, [
    'Group tag',
    'Group Tag',
    'GroupTag',
    'Autopilot group tag',
    'Autopilot Group Tag',
    'Scope tag',
    'Scope Tag'
  ]);
  const mtrRegion = detectMtrRegion({
    assetTag,
    deviceName: assetTag,
    email,
    userName,
    groupTag,
    upn: email
  });

  if (!serialNumber && !field(record, ['Device ID', 'DeviceId', 'Intune Device ID'])) return null;

  let person = null;
  if ((email || userName) && !mtrRegion) {
    const names = parsePersonDisplayName(userName || email);
    const candidate = {
      email,
      displayName: userName || email,
      firstName: names.firstName,
      lastName: names.lastName,
      department: names.department || '',
      role: '',
      externalIds: { upn: email, jamfUsername: '' }
    };
    if (!shouldSkipImportedUser(candidate)) person = candidate;
  }

  return {
    source: 'intune',
    line: record.__line,
    externalId: field(record, ['Device ID', 'DeviceId', 'Intune Device ID']),
    assetTag,
    serialNumber,
    manufacturer,
    model,
    os,
    osVersion: field(record, ['OS version', 'OS Version', 'OSVersion']),
    imei: field(record, ['IMEI']),
    storage: bytesToGb(field(record, ['Total storage', 'Total Storage', 'StorageTotal'])),
    lastSeen: field(record, ['Last check-in', 'Last Check-in', 'LastContact', 'Last contact']),
    enrolledAt: normalizeImportDate(field(record, [
      'Enrollment date',
      'Enrolled date',
      'Device enrollment date',
      'Enrollment Date',
      'Enrolled Date'
    ])),
    groupTag,
    mtrRegion,
    primaryUserUpn: email,
    primaryUserName: userName,
    person,
    raw: record
  };
}

function matchesFilter(row, deviceFilter) {
  if (deviceFilter === 'mtr') return Boolean(row.mtrRegion);
  if (deviceFilter === 'mtr_ro') return row.mtrRegion === 'RO';
  if (deviceFilter === 'mtr_bg') return row.mtrRegion === 'BG';
  if (row.mtrRegion && (deviceFilter === 'laptops' || deviceFilter === 'phones' || deviceFilter === 'macbooks')) {
    return false;
  }
  const os = row.os.toLowerCase();
  const manufacturer = row.manufacturer.toLowerCase();
  const model = row.model.toLowerCase();
  if (deviceFilter === 'laptops') return os.includes('windows') && (manufacturer.includes('lenovo') || model.includes('thinkpad') || isLenovoMtm(model));
  if (deviceFilter === 'phones') return os.includes('ios') || os.includes('android');
  if (deviceFilter === 'macbooks') return false;
  return true;
}

function inferOsIfMissing(os, manufacturer, model) {
  if (String(os ?? '').trim()) return os;
  const mfr = String(manufacturer ?? '').toLowerCase();
  const mdl = String(model ?? '').toLowerCase();
  if (mdl.includes('iphone') || mdl.includes('ipad') || (mfr.includes('apple') && (mdl.includes('iphone') || mdl.includes('ipad') || /^iphone\d/i.test(mdl)))) {
    return 'iOS';
  }
  if (mdl.includes('galaxy') || mdl.includes('pixel') || mfr.includes('samsung') || mfr.includes('google') || mfr.includes('xiaomi')) {
    return 'Android';
  }
  if (mfr.includes('lenovo') || mdl.includes('thinkpad') || /^[0-9]{2}[a-z0-9]{5,}$/i.test(mdl.replace(/[^a-z0-9]/gi, ''))) {
    return 'Windows';
  }
  if (mfr.includes('apple') && (mdl.includes('macbook') || mdl.includes('mac'))) {
    return 'macOS';
  }
  return os;
}

function field(record, names) {
  const aliases = Array.isArray(names) ? names : [names];
  const entries = Object.entries(record);
  for (const alias of aliases) {
    const wanted = normalizeKey(alias);
    const found = entries.find(([key]) => normalizeKey(key) === wanted);
    if (found && String(found[1] ?? '').trim()) return String(found[1]).trim();
  }
  return '';
}

function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isLenovoMtm(value) {
  return /^[0-9a-z]{4}[0-9a-z]{3,}$/i.test(String(value ?? '').replace(/[^a-z0-9]/gi, ''));
}

function bytesToGb(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  if (!number) return '';
  return number > 1024 ? `${Math.round(number / 1024 / 1024 / 1024)} GB` : `${number} GB`;
}
