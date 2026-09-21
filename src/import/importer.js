import { parseCsv } from './csv-parser.js';
import { detectSource } from './detect-source.js';
import { isZip, extractFirstCsvFromZip } from './zip-reader.js';
import { mapIntuneRows } from './intune-mapper.js';
import { mapJamfRows } from './jamf-mapper.js';
import { resolveModel } from './model-resolver.js';

export function buildImportPreview(store, upload, options = {}) {
  const parsed = parseImportFile(upload.buffer, upload.originalName);
  const source = detectSource(parsed.headers, options.source || 'auto');
  const deviceFilter = options.deviceFilter || 'all';
  const mode = options.mode || 'upsert';
  const normalizedRows = source === 'intune'
    ? mapIntuneRows(parsed.records, deviceFilter)
    : mapJamfRows(parsed.records, deviceFilter);

  const rows = normalizedRows.map((normalized) => previewRow(store, normalized, source, mode, options.modelOverrides || {}));
  return {
    source,
    fileName: parsed.fileName,
    options: { source: options.source || 'auto', deviceFilter, mode },
    summary: summarize(rows, parsed.records.length),
    rows
  };
}

export async function applyImport(store, preview, actor) {
  const settings = store.getSettings?.() || { modelOverrides: {} };
  const modelOverrides = { ...(settings.modelOverrides || {}) };
  const rows = preview.rows.map((row) => {
    const overrideModelId = preview.modelOverrides?.[row.rowKey];
    if (overrideModelId && row.serialNumber && preview.persistModelOverrides !== false) {
      modelOverrides[String(row.serialNumber).trim().toLowerCase()] = overrideModelId;
    }
    return overrideModelId && row.needsReview
      ? {
          ...row,
          action: row.intendedAction || 'create',
          modelId: overrideModelId,
          modelMatch: 'manual',
          needsReview: false,
          warnings: row.warnings.filter((warning) => !warning.includes('Model'))
        }
      : row;
  });
  const blocking = rows.filter((row) => row.action !== 'skip' && row.needsReview);
  if (blocking.length) {
    throw new Error('Exista randuri care necesita selectie manuala de model.');
  }
  if (preview.persistModelOverrides !== false && Object.keys(modelOverrides).length) {
    await store.updateSettings({ modelOverrides }, actor);
  }
  return store.applyImportRows(rows, { fileName: preview.fileName }, actor);
}

export function importTemplates() {
  return {
    intune: {
      exportSteps: [
        'Intune admin center > Devices > All devices',
        'Export > Include all inventory data in the exported file',
        'Incarca ZIP-ul descarcat direct in aplicatie'
      ],
      recommendedColumns: [
        'Serial number',
        'Device name',
        'Management name',
        'Manufacturer',
        'Model',
        'OS',
        'OS version',
        'IMEI',
        'Primary user UPN',
        'Primary user display name',
        'Primary user email address',
        'Device ID',
        'Group tag',
        'Last check-in',
        'Enrollment date'
      ]
    },
    jamf: {
      exportSteps: [
        'Jamf Pro > Computers > Search Inventory > New Advanced Search',
        'Display: selecteaza campurile recomandate',
        'View > Export > CSV'
      ],
      recommendedColumns: [
        'Computer Name',
        'Serial Number',
        'Make',
        'Model',
        'Model Identifier',
        'Asset Tag',
        'Username',
        'Full Name',
        'Email Address',
        'Department',
        'Operating System',
        'Operating System Version',
        'Total RAM MB',
        'Jamf Pro Computer ID',
        'Initial Entry Date',
        'Last Enrollment Date'
      ]
    }
  };
}

function parseImportFile(buffer, originalName) {
  if (isZip(buffer)) {
    const csv = extractFirstCsvFromZip(buffer);
    return { ...parseCsv(csv.buffer), fileName: `${originalName}/${csv.fileName}` };
  }
  return { ...parseCsv(buffer), fileName: originalName };
}

function previewRow(store, normalized, source, mode, modelOverrides) {
  const rowKey = `${normalized.source}:${normalized.serialNumber || normalized.externalId || normalized.line}`;
  const existing = store.findAssetForImport(normalized);
  const persistedOverride = store.getModelOverride?.(normalized.serialNumber) || '';
  const overrideModelId = modelOverrides[rowKey]
    || modelOverrides[normalized.serialNumber]
    || modelOverrides[normalized.externalId]
    || modelOverrides[normalized.line]
    || persistedOverride;
  const modelResolution = resolveModel(store.listCatalog(), normalized, {
    [normalized.serialNumber]: overrideModelId,
    [normalized.externalId]: overrideModelId,
    [normalized.line]: overrideModelId
  });
  const existingPersonId = existing ? store.getCurrentAssignment(existing.id)?.personId : '';
  const importedPerson = store.findPersonForImport(normalized.person);
  const importedPersonId = importedPerson?.id;
  const needsReview = !modelResolution.model;
  const baseAction = existing ? (existingPersonId && importedPersonId && existingPersonId !== importedPersonId ? 'reassign' : 'update') : 'create';
  const missingSerial = !normalized.serialNumber;
  const action = missingSerial ? 'skip' : actionForMode(baseAction, mode);
  const warnings = [
    ...modelResolution.warnings,
    missingSerial ? 'Lipseste seria. Randul este sarit pentru a evita duplicatele.' : '',
    action === 'skip' && !missingSerial ? `Rand sarit de modul ${mode}.` : '',
    persistedOverride && modelResolution.model ? 'Model din override salvat pe serial.' : ''
  ].filter(Boolean);

  return {
    rowKey,
    line: normalized.line,
    source,
    action: needsReview && action !== 'skip' ? 'needsReview' : action,
    intendedAction: action,
    needsReview: needsReview && action !== 'skip',
    serialNumber: normalized.serialNumber,
    assetTag: normalized.assetTag,
    modelText: normalized.model || normalized.modelIdentifier || '',
    modelId: modelResolution.model?.id || '',
    modelLabel: modelResolution.model ? modelName(store.listCatalog(), modelResolution.model.id) : '',
    modelMatch: modelResolution.match,
    matchedAssetId: existing?.id || '',
    personName: normalized.person?.displayName || '',
    personEmail: normalized.person?.email || '',
    personMatch: normalized.person ? (importedPerson ? 'existing' : 'new') : 'none',
    warnings,
    normalized
  };
}

function actionForMode(action, mode) {
  if (mode === 'create_only' && action !== 'create') return 'skip';
  if (mode === 'update_only' && action === 'create') return 'skip';
  return action;
}

function summarize(rows, totalInputRows) {
  const summary = {
    total: totalInputRows,
    mapped: rows.length,
    create: 0,
    update: 0,
    reassign: 0,
    skip: 0,
    needsReview: 0
  };
  for (const row of rows) {
    if (row.needsReview) summary.needsReview += 1;
    else if (summary[row.action] !== undefined) summary[row.action] += 1;
  }
  return summary;
}

function modelName(catalog, modelId) {
  const model = catalog.models.find((item) => item.id === modelId);
  const brand = catalog.brands.find((item) => item.id === model?.brandId);
  if (model?.deviceType === 'Telefon') return model.name;
  if (model?.generation === 'Standard' || model?.generation === 'Pro') return model.name;
  return `${brand?.name ?? ''} ${model?.name ?? ''} ${model?.generation ?? ''}`.trim();
}
