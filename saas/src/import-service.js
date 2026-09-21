import { parseCsv } from '../../src/import/csv-parser.js';
import { detectSource } from '../../src/import/detect-source.js';
import { detectUserSource } from '../../src/import/detect-user-source.js';
import { mapIntuneRows } from '../../src/import/intune-mapper.js';
import { mapJamfRows } from '../../src/import/jamf-mapper.js';
import { mapEntraUserRows } from '../../src/import/entra-user-mapper.js';
import { mapIntuneUserRows } from '../../src/import/intune-user-mapper.js';
import { shouldSkipImportedUser } from '../../src/import/excluded-users.js';
import { emptyImportPolicy } from '../../src/import/import-policy.js';
import { isZip, extractFirstCsvFromZip } from '../../src/import/zip-reader.js';

export const IMPORT_SOURCES = ['auto', 'intune', 'jamf'];
export const USER_IMPORT_SOURCES = ['auto', 'entra', 'intune_users'];

// A hosted tenant shares one event loop with every other tenant, so the SaaS
// import is capped well below the shared parser defaults.
const maxColumns = positiveInt(process.env.SAAS_MAX_IMPORT_COLUMNS, 256);
const maxRows = positiveInt(process.env.SAAS_MAX_IMPORT_ROWS, 20_000);

export function buildSaasImportPreview({
  buffer,
  fileName,
  source = 'auto',
  existingAssets = [],
  existingPeople = [],
  policy = emptyImportPolicy()
}) {
  // `source` arrives as a multipart form field. Unvalidated it reaches
  // detectSource(), which returns it verbatim, and then a column constrained to
  // 'intune' or 'jamf'.
  const requestedSource = clean(source) || 'auto';
  if (!IMPORT_SOURCES.includes(requestedSource)) {
    throw badRequest(`source must be one of ${IMPORT_SOURCES.join(', ')}`);
  }
  const parsed = parseImportFile(buffer, fileName);
  const detectedSource = detectSource(parsed.headers, requestedSource);
  // Policy is per request. The shared modules no longer see a process-global
  // exclusion list on this path, so two organizations can import at once.
  const normalizedRows = detectedSource === 'intune'
    ? mapIntuneRows(parsed.records, 'all', policy)
    : mapJamfRows(parsed.records, 'all');

  const assetsBySerial = new Map(
    existingAssets
      .filter((asset) => asset.serialNumber)
      .map((asset) => [key(asset.serialNumber), asset])
  );
  const assetsByTag = new Map(
    existingAssets
      .filter((asset) => asset.assetTag)
      .map((asset) => [key(asset.assetTag), asset])
  );
  const peopleByEmail = new Map(
    existingPeople
      .filter((person) => person.email)
      .map((person) => [key(person.email), person])
  );
  const seenSerials = new Set();

  const rows = normalizedRows.map((normalized) => {
    const serialKey = key(normalized.serialNumber);
    const tagKey = key(normalized.assetTag);
    const existing = assetsBySerial.get(serialKey);
    const tagConflict = assetsByTag.get(tagKey);
    const warnings = [];
    let action = existing ? 'update' : 'create';

    if (!serialKey) {
      action = 'skip';
      warnings.push('Missing serial number.');
    } else if (seenSerials.has(serialKey)) {
      action = 'skip';
      warnings.push('Duplicate serial in this file.');
    } else {
      seenSerials.add(serialKey);
    }

    if (tagConflict && tagConflict.id !== existing?.id) {
      action = 'skip';
      warnings.push('Asset tag is already used by another device in this organization.');
    }

    const personEmail = key(normalized.person?.email || normalized.person?.externalIds?.upn);
    const person = normalized.person
      ? {
          firstName: clean(normalized.person.firstName),
          lastName: clean(normalized.person.lastName),
          email: personEmail,
          department: clean(normalized.person.department),
          role: clean(normalized.person.role)
        }
      : null;
    if (person && !person.email) {
      warnings.push('Person has no email and will not be created automatically.');
    }

    // A device that already belongs to someone else in this organization is a
    // handover, not a plain field update: the preview says so and the apply
    // step closes the previous assignment.
    const matchedPerson = person?.email ? peopleByEmail.get(person.email) : null;
    if (action === 'update' && matchedPerson && existing.personId && existing.personId !== matchedPerson.id) {
      action = 'reassign';
      warnings.push('Device changes owner. The current assignment will be closed.');
    }

    return {
      rowKey: `${detectedSource}:${normalized.serialNumber || normalized.externalId || normalized.line}`,
      line: normalized.line,
      action,
      source: detectedSource,
      serialNumber: clean(normalized.serialNumber),
      assetTag: clean(normalized.assetTag) || clean(normalized.serialNumber),
      modelName: clean(normalized.model || normalized.modelIdentifier),
      manufacturer: clean(normalized.manufacturer),
      category: clean(normalized.mtrRegion ? `MTR ${normalized.mtrRegion}` : ''),
      operatingSystem: [normalized.os, normalized.osVersion].filter(Boolean).join(' ').trim(),
      ramGb: gigabytes(normalized.ram),
      storageGb: gigabytes(normalized.storage),
      cpu: clean(normalized.cpu),
      imei: clean(normalized.imei),
      enrolledAt: clean(normalized.enrolledAt),
      lastEnrolledAt: clean(normalized.lastEnrolledAt),
      notes: buildImportNotes(normalized),
      externalId: clean(normalized.externalId),
      person,
      personMatch: person?.email
        ? (peopleByEmail.has(person.email) ? 'existing' : 'new')
        : 'none',
      matchedAssetId: existing?.id || '',
      previousPersonId: existing?.personId || '',
      warnings
    };
  });

  return {
    source: detectedSource,
    fileName,
    summary: summarize(rows, parsed.records.length),
    rows
  };
}

/**
 * Preview of an Entra / Intune user export. The offline user importer reaches
 * into a process-global exclusion list and an in-memory store; here the policy
 * travels with the request and the existing people arrive as a plain list, so
 * two organizations can import at the same time.
 */
export function buildSaasUserImportPreview({
  buffer,
  fileName,
  source = 'auto',
  existingPeople = [],
  policy = emptyImportPolicy()
}) {
  const requestedSource = clean(source) || 'auto';
  if (!USER_IMPORT_SOURCES.includes(requestedSource)) {
    throw badRequest(`source must be one of ${USER_IMPORT_SOURCES.join(', ')}`);
  }
  const parsed = parseImportFile(buffer, fileName);
  const detectedSource = detectUserSource(parsed.headers, requestedSource);
  const normalizedRows = detectedSource === 'entra'
    ? mapEntraUserRows(parsed.records)
    : mapIntuneUserRows(parsed.records);

  const peopleByEmail = new Map();
  for (const person of existingPeople) {
    for (const email of personEmails(person)) peopleByEmail.set(email, person);
  }
  const seen = new Set();

  const rows = normalizedRows.map((normalized) => {
    const identity = key(normalized.email || normalized.externalIds?.upn);
    const existing = identity ? peopleByEmail.get(identity) : null;
    const warnings = [];
    let action = existing ? 'update' : 'create';

    if (!identity) {
      action = 'skip';
      warnings.push('Missing email and UPN.');
    } else if (seen.has(identity)) {
      action = 'skip';
      warnings.push('Duplicate identity in this file.');
    } else {
      seen.add(identity);
    }
    if (action !== 'skip' && shouldSkipImportedUser(normalized, policy)) {
      action = 'skip';
      warnings.push('Excluded by this organization\u2019s import settings.');
    }

    return {
      rowKey: `${detectedSource}:${identity || normalized.line}`,
      line: normalized.line,
      action,
      source: detectedSource,
      email: identity,
      firstName: clean(normalized.firstName),
      lastName: clean(normalized.lastName),
      displayName: clean(normalized.displayName),
      department: clean(normalized.department),
      role: clean(normalized.role),
      status: normalized.status === 'inactive' ? 'inactive' : 'active',
      externalIds: {
        upn: key(normalized.externalIds?.upn),
        jamfUsername: clean(normalized.externalIds?.jamfUsername),
        entraObjectId: clean(normalized.externalIds?.entraObjectId),
        alternateEmails: []
      },
      matchedPersonId: existing?.id || '',
      personMatch: existing ? 'existing' : (action === 'skip' ? 'none' : 'new'),
      warnings
    };
  });

  return {
    kind: 'users',
    source: detectedSource,
    fileName,
    summary: summarize(rows, parsed.records.length),
    rows
  };
}

function parseImportFile(buffer, fileName) {
  if (isZip(buffer)) {
    const entry = extractFirstCsvFromZip(buffer);
    return { ...parseCsv(entry.buffer, { maxColumns, maxRows }), fileName: `${fileName}/${entry.fileName}` };
  }
  return { ...parseCsv(buffer, { maxColumns, maxRows }), fileName };
}

function personEmails(person) {
  const ids = person.externalIds || {};
  return [person.email, ids.upn, ...(ids.alternateEmails || [])].map(key).filter(Boolean);
}

function buildImportNotes(normalized) {
  return [
    normalized.externalId ? `External ID: ${normalized.externalId}` : '',
    normalized.lastSeen ? `Last seen: ${normalized.lastSeen}` : '',
    normalized.modelIdentifier ? `Model identifier: ${normalized.modelIdentifier}` : ''
  ].filter(Boolean).join('\n');
}

// Mappers hand back human strings such as "16 GB"; the columns are numeric.
function gigabytes(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function summarize(rows, total) {
  return {
    total,
    mapped: rows.length,
    create: rows.filter((row) => row.action === 'create').length,
    update: rows.filter((row) => row.action === 'update').length,
    reassign: rows.filter((row) => row.action === 'reassign').length,
    skip: rows.filter((row) => row.action === 'skip').length,
    warnings: rows.filter((row) => row.warnings.length).length
  };
}

function key(value) {
  return clean(value).toLowerCase();
}

function positiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function clean(value) {
  return String(value ?? '').trim();
}
