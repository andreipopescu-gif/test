import { normalizeImportDate } from '../../../src/import/date-utils.js';
import { parsePersonDisplayName } from '../../../src/utils/person-name.js';
import { detectPreset, getPreset } from './mdm-presets.js';

export function headerSignature(headers) {
  return (headers || [])
    .map((header) => normalizeHeader(header))
    .filter(Boolean)
    .sort()
    .join('|');
}

export function suggestMapping(headers, { kind } = {}) {
  const detected = detectPreset(headers, { kind });
  if (!detected?.preset) {
    return {
      presetKey: '',
      mapping: {},
      score: 0,
      matchedFields: [],
      uncertain: true
    };
  }

  const mapping = buildMappingFromPreset(headers, detected.preset);
  return {
    presetKey: detected.preset.key,
    mapping,
    score: detected.score,
    matchedFields: detected.matchedFields,
    uncertain: Boolean(detected.uncertain)
  };
}

export function applyMapping(records, mapping, sourceKey = 'generic') {
  return records.map((record) => mapRecord(record, mapping, sourceKey)).filter(Boolean);
}

function buildMappingFromPreset(headers, preset) {
  const normalized = new Map();
  for (const header of headers || []) {
    normalized.set(normalizeHeader(header), header);
  }

  const mapping = {};
  for (const [field, aliases] of Object.entries(preset.fields || {})) {
    for (const alias of aliases) {
      const actual = normalized.get(normalizeHeader(alias));
      if (actual) {
        mapping[field] = actual;
        break;
      }
    }
  }
  return mapping;
}

function mapRecord(record, mapping, sourceKey) {
  const serialNumber = field(record, mapping, 'serialNumber');
  const email = field(record, mapping, 'personEmail') || field(record, mapping, 'email');
  const externalId = field(record, mapping, 'externalId');
  if (!serialNumber && !email && !externalId) return null;

  const personName = field(record, mapping, 'personName');
  const names = parsePersonDisplayName(personName || email);
  const isUserImport = Boolean(mapping.email && !mapping.serialNumber);

  if (isUserImport) {
    return {
      source: sourceKey,
      line: record.__line,
      email: email || field(record, mapping, 'email'),
      displayName: personName || `${names.firstName} ${names.lastName}`.trim(),
      firstName: field(record, mapping, 'firstName') || names.firstName,
      lastName: field(record, mapping, 'lastName') || names.lastName,
      department: field(record, mapping, 'department') || names.department || '',
      role: field(record, mapping, 'role'),
      phone: field(record, mapping, 'phone'),
      manager: field(record, mapping, 'manager'),
      location: field(record, mapping, 'location'),
      status: parseUserStatus(field(record, mapping, 'status')),
      externalIds: {},
      raw: record
    };
  }

  return {
    source: sourceKey,
    line: record.__line,
    externalId,
    assetTag: field(record, mapping, 'assetTag') || serialNumber,
    serialNumber,
    manufacturer: field(record, mapping, 'manufacturer'),
    model: field(record, mapping, 'model'),
    modelIdentifier: field(record, mapping, 'modelIdentifier'),
    os: field(record, mapping, 'os'),
    osVersion: field(record, mapping, 'osVersion'),
    ram: field(record, mapping, 'ram'),
    storage: field(record, mapping, 'storage'),
    cpu: field(record, mapping, 'cpu'),
    imei: field(record, mapping, 'imei'),
    enrolledAt: normalizeImportDate(field(record, mapping, 'enrolledAt')),
    lastEnrolledAt: normalizeImportDate(field(record, mapping, 'lastEnrolledAt')),
    person: email || personName
      ? {
          email,
          displayName: personName || email,
          firstName: names.firstName,
          lastName: names.lastName,
          department: field(record, mapping, 'department') || names.department || '',
          role: field(record, mapping, 'role'),
          externalIds: { upn: email }
        }
      : null,
    raw: record
  };
}

function field(record, mapping, canonicalField) {
  const header = mapping?.[canonicalField];
  if (!header) return '';
  const value = record[header];
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseUserStatus(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return 'active';
  if (['inactive', 'disabled', 'suspended', 'false', 'no', 'locked'].some((token) => text.includes(token))) {
    return 'inactive';
  }
  return 'active';
}

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase();
}

export { getPreset, detectPreset };
