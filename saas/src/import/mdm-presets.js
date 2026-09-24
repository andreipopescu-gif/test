const DEVICE_FIELDS = [
  'serialNumber',
  'assetTag',
  'model',
  'manufacturer',
  'modelIdentifier',
  'os',
  'osVersion',
  'personEmail',
  'personName',
  'ram',
  'storage',
  'cpu',
  'imei',
  'enrolledAt',
  'lastEnrolledAt',
  'externalId'
];

const USER_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'department',
  'role',
  'status',
  'phone',
  'manager',
  'location'
];

/** @type {Array<{ key: string, label: string, kind: 'devices'|'users', howToExport: string, fields: Record<string, string[]> }>} */
export const PRESETS = [
  {
    key: 'kandji',
    label: 'Kandji',
    kind: 'devices',
    howToExport: 'Devices → Views → Edit columns → Export CSV.',
    fields: {
      serialNumber: ['Device Serial Number', 'Serial Number', 'Serial number'],
      assetTag: ['Asset Tag', 'Device Name', 'Host Name'],
      model: ['Model Name', 'Model', 'Model Identifier'],
      manufacturer: ['Manufacturer', 'Make'],
      modelIdentifier: ['Model Identifier', 'Hardware Model'],
      os: ['OS Name', 'Operating System', 'Platform'],
      osVersion: ['OS Version', 'Operating System Version'],
      personEmail: ['Device User Email', 'User Email', 'Email Address'],
      personName: ['Device User', 'User Name', 'Full Name'],
      enrolledAt: ['First Enrollment Date', 'First enrollment date'],
      lastEnrolledAt: ['Last Enrollment Date', 'Last enrollment date'],
      externalId: ['Device ID', 'Kandji Device ID']
    }
  },
  {
    key: 'mosyle',
    label: 'Mosyle',
    kind: 'devices',
    howToExport: 'Management → Devices → Export devices CSV.',
    fields: {
      serialNumber: ['Serial Number', 'Serial number'],
      assetTag: ['Device Name', 'Asset Tag', 'Computer Name'],
      model: ['Model', 'Device Model'],
      manufacturer: ['Manufacturer', 'Make'],
      modelIdentifier: ['Model Identifier', 'Model ID'],
      os: ['Operating System', 'OS'],
      osVersion: ['OS Version', 'Operating System Version'],
      personEmail: ['Email', 'User Email', 'Assigned User Email'],
      personName: ['User Name', 'Assigned User', 'Full Name'],
      enrolledAt: ['Enrollment Date', 'Enrolled Date'],
      lastEnrolledAt: ['Last Enrollment Date'],
      externalId: ['Device Udid', 'UDID', 'Device ID']
    }
  },
  {
    key: 'workspace_one',
    label: 'Workspace ONE (UEM)',
    kind: 'devices',
    howToExport: 'Monitor → Reports → List View → Export.',
    fields: {
      serialNumber: ['Serial Number', 'SerialNumber', 'Serial number'],
      assetTag: ['Friendly Name', 'Device Name', 'Asset Number'],
      model: ['Model', 'Device Model'],
      manufacturer: ['Manufacturer', 'OEM'],
      modelIdentifier: ['Model Identifier', 'Hardware Identifier'],
      os: ['Platform', 'Operating System', 'OS'],
      osVersion: ['OS Version', 'Operating System Version'],
      personEmail: ['User Email Address', 'Email Address', 'User Principal Name'],
      personName: ['User Name', 'Display Name'],
      enrolledAt: ['Enrollment Date', 'Enrolled Date'],
      lastEnrolledAt: ['Last Seen', 'Last Check-In'],
      externalId: ['Device ID', 'DeviceUuid', 'UUID']
    }
  },
  {
    key: 'google_chromeos',
    label: 'Google Admin (ChromeOS)',
    kind: 'devices',
    howToExport: 'Devices → Chrome → Devices → Download device list.',
    fields: {
      serialNumber: ['Serial Number', 'Serial number'],
      assetTag: ['Asset Id', 'Asset ID', 'Annotated Asset Id'],
      model: ['Model', 'Device Model'],
      manufacturer: ['Manufacturer'],
      os: ['Platform Version', 'OS Version'],
      osVersion: ['Chrome Version', 'Platform Version'],
      personEmail: ['Most Recent User', 'Recent User Email', 'Primary Email'],
      personName: ['Most Recent User', 'User Name'],
      enrolledAt: ['Enrollment Date', 'First Enrollment Time'],
      lastEnrolledAt: ['Last Enrollment Time', 'Last Sync'],
      externalId: ['Device Id', 'Device ID']
    }
  },
  {
    key: 'jumpcloud',
    label: 'JumpCloud',
    kind: 'devices',
    howToExport: 'Devices → export the systems list as CSV.',
    fields: {
      serialNumber: ['Serial Number', 'serialNumber'],
      assetTag: ['Display Name', 'Hostname', 'System Hostname'],
      model: ['Model', 'Hardware Model'],
      manufacturer: ['Manufacturer', 'Vendor'],
      modelIdentifier: ['Model Identifier'],
      os: ['OS', 'Operating System'],
      osVersion: ['OS Version', 'Version'],
      personEmail: ['Primary User Email', 'User Email'],
      personName: ['Primary User', 'User Name'],
      enrolledAt: ['Created', 'Enrollment Date'],
      lastEnrolledAt: ['Last Contact', 'Last Contact Date'],
      externalId: ['System ID', 'System Id', '_id']
    }
  },
  {
    key: 'ninjaone',
    label: 'NinjaOne',
    kind: 'devices',
    howToExport: 'Devices → select organization → Export.',
    fields: {
      serialNumber: ['Serial Number', 'Serial number', 'BIOS Serial Number'],
      assetTag: ['Device Name', 'System Name', 'Asset Tag'],
      model: ['Model', 'System Model'],
      manufacturer: ['Manufacturer', 'Vendor'],
      modelIdentifier: ['Model Identifier'],
      os: ['Operating System', 'OS Name'],
      osVersion: ['OS Version', 'Operating System Version'],
      personEmail: ['Owner Email', 'User Email'],
      personName: ['Owner Name', 'User Name'],
      enrolledAt: ['Created Date', 'Enrollment Date'],
      lastEnrolledAt: ['Last Contact', 'Last Update'],
      externalId: ['Device ID', 'Node ID', 'Id']
    }
  },
  {
    key: 'manageengine',
    label: 'ManageEngine Endpoint Central',
    kind: 'devices',
    howToExport: 'Inventory → Computers → Export as CSV.',
    fields: {
      serialNumber: ['Serial Number', 'Serial No', 'Service Tag'],
      assetTag: ['Computer Name', 'Device Name', 'Asset Tag'],
      model: ['Model', 'System Model'],
      manufacturer: ['Manufacturer', 'Vendor Name'],
      modelIdentifier: ['Model Identifier'],
      os: ['Operating System', 'OS Name'],
      osVersion: ['OS Version', 'Service Pack'],
      personEmail: ['Email Address', 'User Email', 'Primary Email'],
      personName: ['User Name', 'Logged On User'],
      enrolledAt: ['Registered Time', 'Enrollment Date'],
      lastEnrolledAt: ['Last Contact Time', 'Last Successful Scan'],
      externalId: ['Resource ID', 'Device ID']
    }
  },
  {
    key: 'hexnode',
    label: 'Hexnode UEM',
    kind: 'devices',
    howToExport: 'Reports → Device reports → Export CSV.',
    fields: {
      serialNumber: ['Serial Number', 'Serial number'],
      assetTag: ['Device Name', 'Asset Tag'],
      model: ['Model', 'Device Model'],
      manufacturer: ['Manufacturer', 'Vendor'],
      modelIdentifier: ['Model Identifier'],
      os: ['Platform', 'Operating System'],
      osVersion: ['OS Version', 'Platform Version'],
      personEmail: ['User Email', 'Email'],
      personName: ['User Name', 'User'],
      enrolledAt: ['Enrolled On', 'Enrollment Date'],
      lastEnrolledAt: ['Last Reported', 'Last Seen'],
      externalId: ['Device ID', 'UDID']
    }
  },
  {
    key: 'addigy',
    label: 'Addigy',
    kind: 'devices',
    howToExport: 'Devices → Export devices CSV.',
    fields: {
      serialNumber: ['Serial Number', 'serial_number'],
      assetTag: ['Device Name', 'Computer Name', 'Asset Tag'],
      model: ['Model', 'Hardware Model'],
      manufacturer: ['Manufacturer', 'Make'],
      modelIdentifier: ['Model Identifier', 'Model ID'],
      os: ['OS Version', 'Operating System'],
      osVersion: ['OS Version'],
      personEmail: ['User Email', 'Primary User Email'],
      personName: ['User Name', 'Primary User'],
      enrolledAt: ['Enrollment Date', 'Created At'],
      lastEnrolledAt: ['Last Check-in', 'Last Contact'],
      externalId: ['Agent ID', 'Device ID', 'Addigy ID']
    }
  },
  {
    key: 'soti',
    label: 'SOTI MobiControl',
    kind: 'devices',
    howToExport: 'Devices → Export device inventory CSV.',
    fields: {
      serialNumber: ['Serial Number', 'Serial number', 'IMEI/MEID'],
      assetTag: ['Device Name', 'Friendly Name', 'Asset Tag'],
      model: ['Model', 'Device Model'],
      manufacturer: ['Manufacturer', 'OEM'],
      modelIdentifier: ['Model Identifier'],
      os: ['Platform', 'Operating System'],
      osVersion: ['OS Version', 'Platform Version'],
      personEmail: ['User Email', 'Email Address'],
      personName: ['User Name', 'Assigned User'],
      imei: ['IMEI', 'IMEI/MEID'],
      enrolledAt: ['Enrollment Date', 'Enrolled On'],
      lastEnrolledAt: ['Last Check-in', 'Last Contact'],
      externalId: ['Device ID', 'Device Id']
    }
  },
  {
    key: 'generic',
    label: 'Generic device CSV',
    kind: 'devices',
    howToExport: 'Export any device inventory CSV and map columns manually.',
    fields: {
      serialNumber: ['Serial Number', 'Serial number', 'Serial', 'SN'],
      assetTag: ['Asset Tag', 'Device Name', 'Computer Name', 'Hostname'],
      model: ['Model', 'Device Model', 'Model Name'],
      manufacturer: ['Manufacturer', 'Make', 'Vendor', 'OEM'],
      modelIdentifier: ['Model Identifier', 'Hardware Model', 'Product Name'],
      os: ['OS', 'Operating System', 'Platform'],
      osVersion: ['OS Version', 'Operating System Version'],
      personEmail: ['Email', 'User Email', 'Primary User Email', 'UPN'],
      personName: ['User Name', 'Full Name', 'Assigned User', 'Primary User'],
      ram: ['RAM', 'Total RAM', 'Memory GB', 'Total RAM MB'],
      storage: ['Storage', 'Disk Size', 'Total Storage'],
      cpu: ['CPU', 'Processor'],
      imei: ['IMEI', 'IMEI/MEID'],
      enrolledAt: ['Enrollment Date', 'Enrolled Date', 'First Enrollment Date'],
      lastEnrolledAt: ['Last Enrollment Date', 'Last Check-in', 'Last Seen'],
      externalId: ['Device ID', 'External ID', 'UUID']
    }
  },
  {
    key: 'google_workspace_users',
    label: 'Google Workspace users',
    kind: 'users',
    howToExport: 'Admin console → Directory → Users → Download users.',
    fields: {
      email: ['Email Address', 'Primary Email', 'Email'],
      firstName: ['First Name', 'Given Name'],
      lastName: ['Last Name', 'Family Name'],
      department: ['Department', 'Org Unit Path'],
      role: ['Employee Title', 'Title', 'Job Title'],
      status: ['Status', 'Account Status', 'Suspended'],
      phone: ['Work Phone', 'Phone Number', 'Mobile Phone'],
      manager: ['Manager Email', 'Manager'],
      location: ['Building ID', 'Location', 'Work Address']
    }
  },
  {
    key: 'okta_users',
    label: 'Okta users',
    kind: 'users',
    howToExport: 'Reports → Users → Export CSV.',
    fields: {
      email: ['Email', 'Primary Email', 'Login'],
      firstName: ['First Name', 'firstName'],
      lastName: ['Last Name', 'lastName'],
      department: ['Department', 'Cost Center'],
      role: ['Title', 'Job Title'],
      status: ['Status', 'User Status'],
      phone: ['Mobile Phone', 'Primary Phone'],
      manager: ['Manager', 'Manager Email'],
      location: ['City', 'State', 'Country Code']
    }
  },
  {
    key: 'jumpcloud_users',
    label: 'JumpCloud users',
    kind: 'users',
    howToExport: 'Users → export users CSV.',
    fields: {
      email: ['Email', 'Primary Email', 'username'],
      firstName: ['firstname', 'First Name', 'Given Name'],
      lastName: ['lastname', 'Last Name', 'Family Name'],
      department: ['Department', 'department'],
      role: ['jobTitle', 'Job Title', 'Title'],
      status: ['activated', 'Status', 'Account Locked'],
      phone: ['phoneNumber', 'Phone', 'Mobile Phone'],
      manager: ['manager', 'Manager Email'],
      location: ['location', 'Location', 'Addresses']
    }
  }
];

export function listPresets(kind) {
  if (!kind) return PRESETS.slice();
  return PRESETS.filter((preset) => preset.kind === kind);
}

export function getPreset(key) {
  return PRESETS.find((preset) => preset.key === key) || null;
}

export function scorePreset(headers, preset) {
  const normalizedHeaders = normalizeHeaderSet(headers);
  const matchedFields = new Set();

  for (const [field, aliases] of Object.entries(preset.fields || {})) {
    for (const alias of aliases) {
      if (normalizedHeaders.has(normalizeHeader(alias))) {
        matchedFields.add(field);
        break;
      }
    }
  }

  return {
    key: preset.key,
    label: preset.label,
    kind: preset.kind,
    score: matchedFields.size,
    matchedFields: [...matchedFields]
  };
}

export function detectPreset(headers, { kind } = {}) {
  const candidates = kind ? listPresets(kind) : PRESETS.slice();
  const scored = candidates
    .map((preset) => ({ ...scorePreset(headers, preset), preset }))
    .filter((candidate) => meetsPresetThreshold(candidate))
    .sort(comparePresetCandidates);

  if (scored[0]) return scored[0];

  const bestEffort = candidates
    .map((preset) => ({ ...scorePreset(headers, preset), preset }))
    .sort(comparePresetCandidates);
  return bestEffort[0]?.score
    ? { ...bestEffort[0], uncertain: true }
    : null;
}

function meetsPresetThreshold(candidate) {
  if (candidate.preset.kind === 'devices') {
    return candidate.matchedFields.includes('serialNumber') && candidate.score >= 3;
  }
  return candidate.matchedFields.includes('email') && candidate.score >= 2;
}

function comparePresetCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.preset.key === 'generic') return 1;
  if (b.preset.key === 'generic') return -1;
  return a.label.localeCompare(b.label);
}

export function canonicalFields(kind) {
  return kind === 'users' ? USER_FIELDS.slice() : DEVICE_FIELDS.slice();
}

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeHeaderSet(headers) {
  return new Set((headers || []).map(normalizeHeader));
}
