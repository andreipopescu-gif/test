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
import { resolveModel } from '../../src/import/model-resolver.js';
import { asResolverCatalog, modelLabel, resolveGenericModel } from './catalog.js';
import { applyMapping, headerSignature, suggestMapping } from './import/column-mapper.js';
import { canonicalFields, getPreset, listPresets } from './import/mdm-presets.js';

const LEGACY_DEVICE_SOURCES = ['intune', 'jamf'];
const LEGACY_USER_SOURCES = ['entra', 'intune_users'];
const DEVICE_PRESET_KEYS = listPresets('devices').map((preset) => preset.key);
const USER_PRESET_KEYS = listPresets('users').map((preset) => preset.key);

export const IMPORT_SOURCES = ['auto', ...LEGACY_DEVICE_SOURCES, ...DEVICE_PRESET_KEYS, 'mapped'];
export const USER_IMPORT_SOURCES = ['auto', ...LEGACY_USER_SOURCES, ...USER_PRESET_KEYS, 'mapped'];

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
  catalog = { categories: [], brands: [], models: [] },
  policy = emptyImportPolicy(),
  mapping = null,
  profiles = [],
  profileId = ''
}) {
  const requestedSource = clean(source) || 'auto';
  validateDeviceSource(requestedSource);
  const parsed = parseImportFile(buffer, fileName);
  const signature = headerSignature(parsed.headers);
  const providedMapping = normalizeMapping(mapping);

  let detectedSource = '';
  let profile = null;
  let activeMapping = providedMapping;
  let needsMapping = false;

  if (LEGACY_DEVICE_SOURCES.includes(requestedSource)) {
    detectedSource = requestedSource;
  } else if (requestedSource === 'auto') {
    detectedSource = tryDetectLegacyDeviceSource(parsed.headers) || '';
  } else if (requestedSource.startsWith('profile:')) {
    profile = profiles.find((item) => item.id === requestedSource.slice('profile:'.length));
    if (!profile) throw badRequest('Import profile not found');
    detectedSource = profile.presetKey || 'mapped';
    activeMapping = Object.keys(providedMapping).length ? providedMapping : profile.mapping;
  } else if (DEVICE_PRESET_KEYS.includes(requestedSource) || requestedSource === 'mapped') {
    detectedSource = requestedSource === 'mapped' ? 'mapped' : requestedSource;
  }

  if (!detectedSource) {
    if (profileId) {
      profile = profiles.find((item) => item.id === profileId) || null;
    }
    if (!profile) {
      profile = profiles.find((item) => item.headerSignature === signature) || null;
    }
    if (profile && !Object.keys(activeMapping).length) {
      activeMapping = profile.mapping;
      detectedSource = profile.presetKey || 'mapped';
    }
  }

  if (!detectedSource && !Object.keys(activeMapping).length) {
    const suggestion = suggestMapping(parsed.headers, { kind: 'devices' });
    const certain = suggestion.presetKey
      && !suggestion.uncertain
      && suggestion.mapping?.serialNumber
      && suggestion.score >= 3;
    if (certain && requestedSource === 'auto') {
      detectedSource = suggestion.presetKey;
      activeMapping = suggestion.mapping;
    } else if (DEVICE_PRESET_KEYS.includes(requestedSource) && requestedSource !== 'generic') {
      const preset = getPreset(requestedSource);
      activeMapping = buildMappingFromPresetHeaders(parsed.headers, preset);
      if (!activeMapping.serialNumber) needsMapping = true;
      detectedSource = requestedSource;
    } else {
      needsMapping = true;
      return {
        needsMapping: true,
        kind: 'devices',
        fileName,
        headers: parsed.headers,
        sampleRows: parsed.records.slice(0, 5),
        suggestion,
        canonicalFields: canonicalFields('devices'),
        headerSignature: signature,
        source: suggestion.presetKey || 'mapped'
      };
    }
  }

  if (!detectedSource) detectedSource = 'mapped';
  if (Object.keys(activeMapping).length && !activeMapping.serialNumber && !LEGACY_DEVICE_SOURCES.includes(detectedSource)) {
    needsMapping = true;
  }
  if (needsMapping) {
    const suggestion = suggestMapping(parsed.headers, { kind: 'devices' });
    return {
      needsMapping: true,
      kind: 'devices',
      fileName,
      headers: parsed.headers,
      sampleRows: parsed.records.slice(0, 5),
      suggestion: {
        ...suggestion,
        mapping: Object.keys(activeMapping).length ? activeMapping : suggestion.mapping
      },
      canonicalFields: canonicalFields('devices'),
      headerSignature: signature,
      source: detectedSource || suggestion.presetKey || 'mapped'
    };
  }

  const normalizedRows = LEGACY_DEVICE_SOURCES.includes(detectedSource)
    ? (detectedSource === 'intune'
      ? mapIntuneRows(parsed.records, 'all', policy)
      : mapJamfRows(parsed.records, 'all'))
    : applyMapping(parsed.records, activeMapping, detectedSource);

  const resolverCatalog = asResolverCatalog(catalog);
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

    const rowKey = `${detectedSource}:${normalized.serialNumber || normalized.externalId || normalized.line}`;
    const overrideModelId = policy.modelOverrides?.[rowKey]
      || policy.modelOverrides?.[normalized.serialNumber]
      || policy.modelOverrides?.[normalized.externalId]
      || policy.modelOverrides?.[String(normalized.line)];
    const resolution = resolveImportModel(
      catalog,
      resolverCatalog,
      { ...normalized, source: detectedSource },
      overrideModelId
    );
    warnings.push(...(resolution.warnings || []));
    const needsReview = action !== 'skip' && !resolution.model;
    if (needsReview) action = 'needs_review';

    const resolvedLabel = resolution.model
      ? modelLabel(resolution.model, resolverCatalog.brands || catalog.brands)
      : '';

    return {
      rowKey,
      line: normalized.line,
      action,
      needsReview,
      source: detectedSource,
      serialNumber: clean(normalized.serialNumber),
      assetTag: clean(normalized.assetTag) || clean(normalized.serialNumber),
      modelId: resolution.model?.id || '',
      modelMatch: resolution.match || 'none',
      modelName: resolvedLabel || clean(normalized.model || normalized.modelIdentifier),
      manufacturer: clean(normalized.manufacturer),
      category: clean(
        resolution.model?.deviceType
          || resolution.category
          || (normalized.mtrRegion ? `MTR ${normalized.mtrRegion}` : '')
      ),
      brand: clean(
        resolution.brand
          || (resolverCatalog.brands || catalog.brands)
            .find((brand) => brand.id === resolution.model?.brandId)?.name
          || ''
      ),
      location: clean(normalized.location),
      operatingSystem: [normalized.os, normalized.osVersion].filter(Boolean).join(' ').trim(),
      ramGb: gigabytes(normalized.ram),
      storageGb: gigabytes(normalized.storage),
      cpu: clean(normalized.cpu),
      imei: clean(normalized.imei),
      enrolledAt: clean(normalized.enrolledAt),
      lastEnrolledAt: clean(normalized.lastEnrolledAt || normalized.lastSeen),
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
    kind: 'devices',
    headerSignature: signature,
    mapping: LEGACY_DEVICE_SOURCES.includes(detectedSource) ? null : activeMapping,
    profileId: profile?.id || profileId || '',
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
  policy = emptyImportPolicy(),
  mapping = null,
  profiles = [],
  profileId = ''
}) {
  const requestedSource = clean(source) || 'auto';
  validateUserSource(requestedSource);
  const parsed = parseImportFile(buffer, fileName);
  const signature = headerSignature(parsed.headers);
  const providedMapping = normalizeMapping(mapping);

  let detectedSource = '';
  let profile = null;
  let activeMapping = providedMapping;

  if (LEGACY_USER_SOURCES.includes(requestedSource)) {
    detectedSource = requestedSource;
  } else if (requestedSource === 'auto') {
    detectedSource = tryDetectLegacyUserSource(parsed.headers) || '';
  } else if (requestedSource.startsWith('profile:')) {
    profile = profiles.find((item) => item.id === requestedSource.slice('profile:'.length));
    if (!profile) throw badRequest('Import profile not found');
    detectedSource = profile.presetKey || 'mapped';
    activeMapping = Object.keys(providedMapping).length ? providedMapping : profile.mapping;
  } else if (USER_PRESET_KEYS.includes(requestedSource) || requestedSource === 'mapped') {
    detectedSource = requestedSource === 'mapped' ? 'mapped' : requestedSource;
  }

  if (!detectedSource) {
    if (profileId) profile = profiles.find((item) => item.id === profileId) || null;
    if (!profile) profile = profiles.find((item) => item.headerSignature === signature) || null;
    if (profile && !Object.keys(activeMapping).length) {
      activeMapping = profile.mapping;
      detectedSource = profile.presetKey || 'mapped';
    }
  }

  if (!detectedSource && !Object.keys(activeMapping).length) {
    const suggestion = suggestMapping(parsed.headers, { kind: 'users' });
    const certain = suggestion.presetKey
      && !suggestion.uncertain
      && suggestion.mapping?.email
      && suggestion.score >= 2;
    if (certain && requestedSource === 'auto') {
      detectedSource = suggestion.presetKey;
      activeMapping = suggestion.mapping;
    } else {
      return {
        needsMapping: true,
        kind: 'users',
        fileName,
        headers: parsed.headers,
        sampleRows: parsed.records.slice(0, 5),
        suggestion,
        canonicalFields: canonicalFields('users'),
        headerSignature: signature,
        source: suggestion.presetKey || 'mapped'
      };
    }
  }

  if (!detectedSource) detectedSource = 'mapped';
  if (Object.keys(activeMapping).length && !activeMapping.email && !LEGACY_USER_SOURCES.includes(detectedSource)) {
    const suggestion = suggestMapping(parsed.headers, { kind: 'users' });
    return {
      needsMapping: true,
      kind: 'users',
      fileName,
      headers: parsed.headers,
      sampleRows: parsed.records.slice(0, 5),
      suggestion: {
        ...suggestion,
        mapping: Object.keys(activeMapping).length ? activeMapping : suggestion.mapping
      },
      canonicalFields: canonicalFields('users'),
      headerSignature: signature,
      source: detectedSource || suggestion.presetKey || 'mapped'
    };
  }

  const normalizedRows = LEGACY_USER_SOURCES.includes(detectedSource)
    ? (detectedSource === 'entra'
      ? mapEntraUserRows(parsed.records)
      : mapIntuneUserRows(parsed.records))
    : applyMapping(parsed.records, activeMapping, detectedSource);

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
    headerSignature: signature,
    mapping: LEGACY_USER_SOURCES.includes(detectedSource) ? null : activeMapping,
    profileId: profile?.id || profileId || '',
    summary: summarize(rows, parsed.records.length),
    rows
  };
}

function resolveImportModel(catalog, resolverCatalog, normalized, overrideModelId) {
  if (overrideModelId) {
    const forced = (catalog.models || []).find((model) => model.id === overrideModelId);
    if (forced) {
      const brand = (catalog.brands || []).find((item) => item.id === forced.brandId);
      return {
        model: forced,
        match: 'override',
        warnings: [],
        brand: brand?.name || '',
        category: ''
      };
    }
  }

  if (LEGACY_DEVICE_SOURCES.includes(normalized.source)) {
    const resolution = resolveModel(resolverCatalog, normalized, {});
    if (resolution.model) {
      return {
        ...resolution,
        brand: (resolverCatalog.brands || []).find((brand) => brand.id === resolution.model.brandId)?.name || '',
        category: resolution.model.deviceType || ''
      };
    }
  }

  const generic = resolveGenericModel(catalog, {
    manufacturer: normalized.manufacturer,
    model: normalized.model,
    modelIdentifier: normalized.modelIdentifier
  });
  if (generic.model) {
    const brand = (catalog.brands || []).find((item) => item.id === generic.model.brandId);
    const category = (catalog.categories || []).find((item) => item.id === brand?.categoryId);
    return {
      model: generic.model,
      match: generic.match,
      warnings: generic.warnings || [],
      brand: brand?.name || '',
      category: category?.name || generic.model.deviceType || ''
    };
  }

  if (LEGACY_DEVICE_SOURCES.includes(normalized.source)) {
    return {
      model: null,
      match: 'none',
      warnings: ['Model could not be resolved from Intune/Jamf or the tenant catalog.'],
      brand: '',
      category: ''
    };
  }

  return {
    model: null,
    match: 'none',
    warnings: generic.warnings?.length
      ? generic.warnings
      : ['Model could not be matched to the tenant catalog.'],
    brand: '',
    category: ''
  };
}

function tryDetectLegacyDeviceSource(headers) {
  try {
    const source = detectSource(headers, 'auto');
    return LEGACY_DEVICE_SOURCES.includes(source) ? source : '';
  } catch {
    return '';
  }
}

function tryDetectLegacyUserSource(headers) {
  try {
    const source = detectUserSource(headers, 'auto');
    return LEGACY_USER_SOURCES.includes(source) ? source : '';
  } catch {
    return '';
  }
}

function validateDeviceSource(source) {
  if (
    IMPORT_SOURCES.includes(source)
    || source.startsWith('profile:')
  ) return;
  throw badRequest(`source must be one of ${IMPORT_SOURCES.join(', ')} or profile:<id>`);
}

function validateUserSource(source) {
  if (
    USER_IMPORT_SOURCES.includes(source)
    || source.startsWith('profile:')
  ) return;
  throw badRequest(`source must be one of ${USER_IMPORT_SOURCES.join(', ')} or profile:<id>`);
}

function buildMappingFromPresetHeaders(headers, preset) {
  if (!preset) return {};
  const suggestion = suggestMapping(headers, { kind: preset.kind });
  if (suggestion.presetKey === preset.key) return suggestion.mapping;
  const normalized = new Map((headers || []).map((header) => [String(header).trim().toLowerCase(), header]));
  const mapping = {};
  for (const [field, aliases] of Object.entries(preset.fields || {})) {
    for (const alias of aliases) {
      const actual = normalized.get(String(alias).trim().toLowerCase());
      if (actual) {
        mapping[field] = actual;
        break;
      }
    }
  }
  return mapping;
}

function normalizeMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return {};
  const result = {};
  for (const [field, header] of Object.entries(mapping)) {
    const keyName = clean(field);
    const value = clean(header);
    if (keyName && value) result[keyName] = value;
  }
  return result;
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
    needsReview: rows.filter((row) => row.action === 'needs_review').length,
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
