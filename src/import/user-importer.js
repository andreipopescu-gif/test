import { parseCsv } from './csv-parser.js';
import { detectUserSource } from './detect-user-source.js';
import { isZip, extractFirstCsvFromZip } from './zip-reader.js';
import { mapEntraUserRows } from './entra-user-mapper.js';
import { mapIntuneUserRows } from './intune-user-mapper.js';
import { detectMtrRegion, shouldSkipImportedUser } from './excluded-users.js';

export function buildUserImportPreview(store, upload, options = {}) {
  const parsed = parseImportFile(upload.buffer, upload.originalName);
  const source = detectUserSource(parsed.headers, options.source || 'auto');
  const mode = options.mode || 'upsert';
  const normalizedRows = source === 'entra'
    ? mapEntraUserRows(parsed.records)
    : mapIntuneUserRows(parsed.records);
  const rows = normalizedRows.map((normalized) => previewUserRow(store, normalized, source, mode));

  return {
    kind: 'users',
    source,
    fileName: parsed.fileName,
    options: { source: options.source || 'auto', mode },
    summary: summarizeUserRows(rows, parsed.records.length),
    rows
  };
}

export async function applyUserImport(store, preview, actor) {
  return store.applyUserImportRows(preview.rows, { fileName: preview.fileName }, actor);
}

export function userImportTemplates() {
  return {
    entra: {
      exportSteps: [
        'Microsoft Entra admin center > Users > All users',
        'Download users (CSV) sau Bulk operations > Download users',
        'Incarca CSV-ul in aplicatie (fara export de dispozitive)'
      ],
      recommendedColumns: [
        'User principal name',
        'Display name',
        'First name',
        'Last name',
        'Mail',
        'Department',
        'Job title',
        'Office location',
        'Mobile phone',
        'Manager',
        'Account enabled',
        'Object Id'
      ]
    },
    intune_users: {
      exportSteps: [
        'Intune admin center > Devices > All devices > Export',
        'Aplicatia extrage utilizatorii unici din coloanele Primary user',
        'Poti folosi acelasi ZIP/CSV ca la importul de dispozitive'
      ],
      recommendedColumns: [
        'Primary user UPN',
        'Primary user display name',
        'Primary user email address',
        'Department',
        'Job title'
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

function previewUserRow(store, normalized, source, mode) {
  const identity = normalized.email || normalized.externalIds?.upn || '';
  const rowKey = `${source}:${identity || normalized.line}`;
  const existing = store.findPersonForImport(normalized);
  const missingIdentity = !identity;
  const mtrRegion = detectMtrRegion({
    email: normalized.email,
    upn: normalized.externalIds?.upn,
    userName: normalized.displayName,
    deviceName: normalized.displayName
  });
  const excludedVendor = shouldSkipImportedUser(normalized);
  const existingMtr = mtrRegion ? store.findMtrRoomAsset(normalized) : null;

  if (mtrRegion && !missingIdentity) {
    const mtrAction = existingMtr ? 'update_mtr' : 'create_mtr';
    const action = actionForMode(existingMtr ? 'update' : 'create', mode) === 'skip' ? 'skip' : mtrAction;
    return {
      rowKey,
      line: normalized.line,
      source,
      action,
      mtrRegion,
      personName: normalized.displayName || `${normalized.firstName} ${normalized.lastName}`.trim(),
      personEmail: identity,
      personDepartment: normalized.department || '',
      personRole: normalized.role || '',
      personPhone: normalized.phone || '',
      personMatch: existingMtr ? 'existing_mtr' : 'new_mtr',
      warnings: [
        action === 'skip'
          ? `Rand MTR sarit de modul ${mode}.`
          : `Cont Teams Room ${mtrRegion} — se importa ca device in MTR ${mtrRegion} (nu ca user).`
      ].filter(Boolean),
      normalized
    };
  }

  const excluded = excludedVendor;
  const baseAction = existing ? 'update' : 'create';
  let action = missingIdentity || excluded ? 'skip' : actionForMode(baseAction, mode);
  const aliasMatch = Boolean(existing && identity && existing.email &&
    existing.email.toLowerCase() !== identity.toLowerCase() &&
    (existing.externalIds?.upn || '').toLowerCase() !== identity.toLowerCase());
  const warnings = [
    missingIdentity ? 'Lipseste email/UPN. Randul este sarit.' : '',
    excluded ? 'User exclus din import (lista IT).' : '',
    aliasMatch ? `Potrivit ca alias email cu ${existing.email} (nu se creeaza duplicat).` : '',
    action === 'skip' && !missingIdentity && !excluded ? `Rand sarit de modul ${mode}.` : ''
  ].filter(Boolean);

  return {
    rowKey,
    line: normalized.line,
    source,
    action,
    personName: normalized.displayName || `${normalized.firstName} ${normalized.lastName}`.trim(),
    personEmail: normalized.email || normalized.externalIds?.upn || '',
    personDepartment: normalized.department || '',
    personRole: normalized.role || '',
    personPhone: normalized.phone || '',
    personMatch: existing ? (aliasMatch ? 'alias' : 'existing') : 'new',
    warnings,
    normalized
  };
}

function actionForMode(action, mode) {
  if (mode === 'create_only' && action !== 'create') return 'skip';
  if (mode === 'update_only' && action === 'create') return 'skip';
  return action;
}

function summarizeUserRows(rows, totalInputRows) {
  const summary = {
    total: totalInputRows,
    mapped: rows.length,
    create: 0,
    update: 0,
    create_mtr: 0,
    update_mtr: 0,
    skip: 0
  };
  for (const row of rows) {
    if (summary[row.action] !== undefined) summary[row.action] += 1;
  }
  return summary;
}
