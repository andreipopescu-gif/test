import { parseCsv } from '../../src/import/csv-parser.js';
import { detectSource } from '../../src/import/detect-source.js';
import { mapIntuneRows } from '../../src/import/intune-mapper.js';
import { mapJamfRows } from '../../src/import/jamf-mapper.js';
import { setRuntimeExcludedUsers } from '../../src/import/excluded-users.js';
import { setRuntimeIdentityGroups } from '../../src/import/known-person-aliases.js';

// The shared import modules ship with defaults for the original single-company
// deployment. A multi-client host must start from empty lists, otherwise one
// customer's exclusions and aliases would silently apply to every organization.
setRuntimeExcludedUsers({ emails: [], nameRules: [], useDefaults: false });
setRuntimeIdentityGroups([], { useDefaults: false });

export const IMPORT_SOURCES = ['auto', 'intune', 'jamf'];

// A hosted tenant shares one event loop with every other tenant, so the SaaS
// import is capped well below the shared parser defaults.
const maxColumns = positiveInt(process.env.SAAS_MAX_IMPORT_COLUMNS, 256);
const maxRows = positiveInt(process.env.SAAS_MAX_IMPORT_ROWS, 20_000);

export function buildSaasImportPreview({
  buffer,
  fileName,
  source = 'auto',
  existingAssets = [],
  existingPeople = []
}) {
  // `source` arrives as a multipart form field. Unvalidated it reaches
  // detectSource(), which returns it verbatim, and then a column constrained to
  // 'intune' or 'jamf'.
  const requestedSource = clean(source) || 'auto';
  if (!IMPORT_SOURCES.includes(requestedSource)) {
    throw badRequest(`source must be one of ${IMPORT_SOURCES.join(', ')}`);
  }
  const parsed = parseCsv(buffer, { maxColumns, maxRows });
  const detectedSource = detectSource(parsed.headers, requestedSource);
  const normalizedRows = detectedSource === 'intune'
    ? mapIntuneRows(parsed.records, 'all')
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

    return {
      rowKey: `${detectedSource}:${normalized.serialNumber || normalized.externalId || normalized.line}`,
      line: normalized.line,
      action,
      source: detectedSource,
      serialNumber: clean(normalized.serialNumber),
      assetTag: clean(normalized.assetTag) || clean(normalized.serialNumber),
      modelName: clean(normalized.model || normalized.modelIdentifier),
      manufacturer: clean(normalized.manufacturer),
      operatingSystem: [normalized.os, normalized.osVersion].filter(Boolean).join(' ').trim(),
      externalId: clean(normalized.externalId),
      person,
      personMatch: person?.email
        ? (peopleByEmail.has(person.email) ? 'existing' : 'new')
        : 'none',
      matchedAssetId: existing?.id || '',
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

function summarize(rows, total) {
  return {
    total,
    mapped: rows.length,
    create: rows.filter((row) => row.action === 'create').length,
    update: rows.filter((row) => row.action === 'update').length,
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
