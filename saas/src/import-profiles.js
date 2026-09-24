import { randomUUID } from 'node:crypto';
import { headerSignature } from './import/column-mapper.js';

export async function listImportProfiles(db, organizationId) {
  const rows = await db.all(`
    SELECT id, name, preset_key AS "presetKey", header_signature AS "headerSignature",
           mapping_json AS "mappingJson", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM import_profiles
    WHERE organization_id = ?
    ORDER BY LOWER(name), created_at
  `, [organizationId]);
  return rows.map(decorateProfile);
}

export async function getImportProfile(db, organizationId, profileId) {
  const row = await db.get(`
    SELECT id, name, preset_key AS "presetKey", header_signature AS "headerSignature",
           mapping_json AS "mappingJson", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM import_profiles
    WHERE id = ? AND organization_id = ?
  `, [profileId, organizationId]);
  return row ? decorateProfile(row) : null;
}

export async function findProfileBySignature(db, organizationId, signature) {
  if (!signature) return null;
  const row = await db.get(`
    SELECT id, name, preset_key AS "presetKey", header_signature AS "headerSignature",
           mapping_json AS "mappingJson", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM import_profiles
    WHERE organization_id = ? AND header_signature = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `, [organizationId, signature]);
  return row ? decorateProfile(row) : null;
}

export async function createImportProfile(db, organizationId, input) {
  const name = clean(input.name);
  if (!name) throw badRequest('Profile name is required');
  const mapping = normalizeMapping(input.mapping);
  if (!Object.keys(mapping).length) throw badRequest('mapping is required');

  const headers = Array.isArray(input.headers) ? input.headers : [];
  const signature = clean(input.headerSignature) || headerSignature(headers);
  if (!signature) throw badRequest('headerSignature or headers are required');

  const id = randomUUID();
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO import_profiles (
      id, organization_id, name, preset_key, header_signature, mapping_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    organizationId,
    name,
    clean(input.presetKey) || 'mapped',
    signature,
    JSON.stringify(mapping),
    now,
    now
  ]);
  return getImportProfile(db, organizationId, id);
}

export async function updateImportProfile(db, organizationId, profileId, input) {
  const existing = await getImportProfile(db, organizationId, profileId);
  if (!existing) throw notFound('Import profile not found');

  const name = input.name === undefined ? existing.name : clean(input.name);
  if (!name) throw badRequest('Profile name is required');
  const mapping = input.mapping === undefined ? existing.mapping : normalizeMapping(input.mapping);
  const presetKey = input.presetKey === undefined ? existing.presetKey : (clean(input.presetKey) || 'mapped');
  const signature = input.headerSignature === undefined
    ? existing.headerSignature
    : clean(input.headerSignature);
  if (!signature) throw badRequest('headerSignature is required');

  const now = new Date().toISOString();
  await db.run(`
    UPDATE import_profiles
    SET name = ?, preset_key = ?, header_signature = ?, mapping_json = ?, updated_at = ?
    WHERE id = ? AND organization_id = ?
  `, [name, presetKey, signature, JSON.stringify(mapping), now, profileId, organizationId]);
  return getImportProfile(db, organizationId, profileId);
}

export async function deleteImportProfile(db, organizationId, profileId) {
  const existing = await getImportProfile(db, organizationId, profileId);
  if (!existing) throw notFound('Import profile not found');
  await db.run(
    'DELETE FROM import_profiles WHERE id = ? AND organization_id = ?',
    [profileId, organizationId]
  );
  return { deleted: true, id: profileId };
}

function decorateProfile(row) {
  return {
    id: row.id,
    name: row.name,
    presetKey: row.presetKey || 'mapped',
    headerSignature: row.headerSignature || '',
    mapping: parseJson(row.mappingJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function normalizeMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return {};
  const result = {};
  for (const [field, header] of Object.entries(mapping)) {
    const key = clean(field);
    const value = clean(header);
    if (key && value) result[key] = value;
  }
  return result;
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function clean(value) {
  return String(value ?? '').trim();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}
