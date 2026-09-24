import { randomUUID } from 'node:crypto';

export const DEFAULT_STATUSES = [
  { key: 'in_stock', label: 'In stock', sortOrder: 0, meta: { countsAs: 'inventory' } },
  { key: 'assigned', label: 'Assigned', sortOrder: 1, meta: { countsAs: 'assigned' } },
  { key: 'deployed', label: 'Deployed (MTR)', sortOrder: 2, meta: { countsAs: 'deployed' } },
  { key: 'service', label: 'In service', sortOrder: 3, meta: { countsAs: 'service' } },
  { key: 'retired', label: 'Retired', sortOrder: 4, meta: { countsAs: 'retired' } }
];

const OPTION_KINDS = new Set(['status', 'department', 'location']);
const CUSTOM_FIELD_TYPES = new Set(['text', 'number', 'date', 'select', 'boolean']);
const CUSTOM_FIELD_ENTITIES = new Set(['asset', 'person']);

export async function ensureOptionsSeeded(db, organizationId) {
  const existing = await db.get(
    'SELECT 1 AS present FROM org_options WHERE organization_id = ? LIMIT 1',
    [organizationId]
  );
  if (existing) return false;

  await db.transaction(async (tx) => {
    for (const status of DEFAULT_STATUSES) {
      await insertOption(tx, organizationId, 'status', status);
    }
  });
  return true;
}

export async function listOptions(db, organizationId, kind, { includeArchived = false } = {}) {
  if (!OPTION_KINDS.has(kind)) throw badRequest('Invalid option kind');
  await ensureOptionsSeeded(db, organizationId);
  const archiveFilter = includeArchived ? '' : 'AND archived_at IS NULL';
  const rows = await db.all(`
    SELECT id, kind, key, label, sort_order AS "sortOrder", archived_at AS "archivedAt", meta_json AS "metaJson"
    FROM org_options
    WHERE organization_id = ? AND kind = ? ${archiveFilter}
    ORDER BY sort_order, LOWER(label)
  `, [organizationId, kind]);
  return rows.map(decorateOption);
}

export async function createOption(db, organizationId, kind, input) {
  if (!OPTION_KINDS.has(kind)) throw badRequest('Invalid option kind');
  await ensureOptionsSeeded(db, organizationId);

  const label = clean(input.label);
  if (!label) throw badRequest('Label is required');
  const key = clean(input.key) || catalogKey(label);
  const duplicate = await db.get(
    'SELECT id FROM org_options WHERE organization_id = ? AND kind = ? AND key = ? AND archived_at IS NULL',
    [organizationId, kind, key]
  );
  if (duplicate) throw badRequest('Option already exists');

  const sortOrder = Number.isFinite(input.sortOrder)
    ? input.sortOrder
    : await nextSortOrder(db, organizationId, kind);
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {};
  const id = randomUUID();
  await db.run(`
    INSERT INTO org_options (id, organization_id, kind, key, label, sort_order, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, organizationId, kind, key, label, sortOrder, JSON.stringify(meta)]);
  return getOption(db, organizationId, id);
}

export async function updateOption(db, organizationId, optionId, input) {
  const existing = await getOption(db, organizationId, optionId);
  if (!existing) throw notFound('Option not found');

  const label = input.label === undefined ? existing.label : clean(input.label);
  if (!label) throw badRequest('Label is required');
  const key = input.key === undefined ? existing.key : (clean(input.key) || catalogKey(label));
  const duplicate = await db.get(
    `SELECT id FROM org_options
     WHERE organization_id = ? AND kind = ? AND key = ? AND id <> ? AND archived_at IS NULL`,
    [organizationId, existing.kind, key, optionId]
  );
  if (duplicate) throw badRequest('Another option already uses that key');

  const sortOrder = input.sortOrder === undefined ? existing.sortOrder : input.sortOrder;
  const meta = input.meta === undefined ? existing.meta : (input.meta || {});
  await db.run(`
    UPDATE org_options
    SET key = ?, label = ?, sort_order = ?, meta_json = ?
    WHERE id = ? AND organization_id = ?
  `, [key, label, sortOrder, JSON.stringify(meta), optionId, organizationId]);
  return getOption(db, organizationId, optionId);
}

export async function deleteOption(db, organizationId, optionId) {
  const existing = await getOption(db, organizationId, optionId);
  if (!existing) throw notFound('Option not found');

  if (existing.kind === 'status' && DEFAULT_STATUSES.some((item) => item.key === existing.key)) {
    throw badRequest('Default status options cannot be deleted');
  }

  const archivedAt = new Date().toISOString();
  await db.run(
    'UPDATE org_options SET archived_at = ? WHERE id = ? AND organization_id = ?',
    [archivedAt, optionId, organizationId]
  );
  return { archived: true, id: optionId };
}

export async function listCustomFields(db, organizationId, entity, { includeArchived = false } = {}) {
  if (!CUSTOM_FIELD_ENTITIES.has(entity)) throw badRequest('Invalid custom field entity');
  const archiveFilter = includeArchived ? '' : 'AND archived_at IS NULL';
  const rows = await db.all(`
    SELECT id, entity, key, label, type, options_json AS "optionsJson", required,
           sort_order AS "sortOrder", archived_at AS "archivedAt"
    FROM custom_field_defs
    WHERE organization_id = ? AND entity = ? ${archiveFilter}
    ORDER BY sort_order, LOWER(label)
  `, [organizationId, entity]);
  return rows.map(decorateCustomField);
}

export async function createCustomField(db, organizationId, entity, input) {
  if (!CUSTOM_FIELD_ENTITIES.has(entity)) throw badRequest('Invalid custom field entity');

  const label = clean(input.label);
  if (!label) throw badRequest('Label is required');
  const key = clean(input.key) || catalogKey(label);
  const type = clean(input.type) || 'text';
  if (!CUSTOM_FIELD_TYPES.has(type)) throw badRequest('Invalid custom field type');

  const duplicate = await db.get(
    'SELECT id FROM custom_field_defs WHERE organization_id = ? AND entity = ? AND key = ? AND archived_at IS NULL',
    [organizationId, entity, key]
  );
  if (duplicate) throw badRequest('Custom field already exists');

  const options = Array.isArray(input.options) ? input.options.map(clean).filter(Boolean) : [];
  const required = Boolean(input.required);
  const sortOrder = Number.isFinite(input.sortOrder)
    ? input.sortOrder
    : await nextCustomFieldSortOrder(db, organizationId, entity);
  const id = randomUUID();
  await db.run(`
    INSERT INTO custom_field_defs (
      id, organization_id, entity, key, label, type, options_json, required, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, organizationId, entity, key, label, type, JSON.stringify(options), required ? 1 : 0, sortOrder]);
  return getCustomField(db, organizationId, id);
}

export async function updateCustomField(db, organizationId, fieldId, input) {
  const existing = await getCustomField(db, organizationId, fieldId);
  if (!existing) throw notFound('Custom field not found');

  const label = input.label === undefined ? existing.label : clean(input.label);
  if (!label) throw badRequest('Label is required');
  const key = input.key === undefined ? existing.key : (clean(input.key) || catalogKey(label));
  const type = input.type === undefined ? existing.type : clean(input.type);
  if (!CUSTOM_FIELD_TYPES.has(type)) throw badRequest('Invalid custom field type');

  const duplicate = await db.get(
    `SELECT id FROM custom_field_defs
     WHERE organization_id = ? AND entity = ? AND key = ? AND id <> ? AND archived_at IS NULL`,
    [organizationId, existing.entity, key, fieldId]
  );
  if (duplicate) throw badRequest('Another custom field already uses that key');

  const options = input.options === undefined
    ? existing.options
    : (Array.isArray(input.options) ? input.options.map(clean).filter(Boolean) : []);
  const required = input.required === undefined ? existing.required : Boolean(input.required);
  const sortOrder = input.sortOrder === undefined ? existing.sortOrder : input.sortOrder;

  await db.run(`
    UPDATE custom_field_defs
    SET key = ?, label = ?, type = ?, options_json = ?, required = ?, sort_order = ?
    WHERE id = ? AND organization_id = ?
  `, [
    key,
    label,
    type,
    JSON.stringify(options),
    required ? 1 : 0,
    sortOrder,
    fieldId,
    organizationId
  ]);
  return getCustomField(db, organizationId, fieldId);
}

export async function deleteCustomField(db, organizationId, fieldId) {
  const existing = await getCustomField(db, organizationId, fieldId);
  if (!existing) throw notFound('Custom field not found');

  const archivedAt = new Date().toISOString();
  await db.run(
    'UPDATE custom_field_defs SET archived_at = ? WHERE id = ? AND organization_id = ?',
    [archivedAt, fieldId, organizationId]
  );
  return { archived: true, id: fieldId };
}

export function validateStatus(statusKey, statusOptions = []) {
  const key = clean(statusKey);
  if (!key) return { valid: false, key: '', reason: 'Status is required' };
  const match = statusOptions.find((item) => item.key === key && !item.archivedAt);
  if (match) return { valid: true, key, option: match };
  const fallback = DEFAULT_STATUSES.find((item) => item.key === key);
  if (fallback) return { valid: true, key, option: fallback };
  return { valid: false, key, reason: 'Unknown status' };
}

export function validateDepartment(departmentLabel, departmentOptions = []) {
  const label = clean(departmentLabel);
  if (!label) return { valid: true, key: '', label: '' };
  const match = departmentOptions.find((item) =>
    item.label.toLowerCase() === label.toLowerCase() && !item.archivedAt
  );
  if (match) return { valid: true, key: match.key, label: match.label };
  return { valid: true, key: catalogKey(label), label, autoCreate: true };
}

export function validateLocation(locationKey, locationOptions = []) {
  const key = clean(locationKey);
  if (!key) return { valid: true, key: '', label: '' };
  const match = locationOptions.find((item) => item.key === key && !item.archivedAt);
  if (match) return { valid: true, key: match.key, label: match.label };
  return { valid: false, key, reason: 'Unknown location' };
}

export async function ensureDepartmentOption(db, organizationId, label) {
  const cleanLabel = clean(label);
  if (!cleanLabel) return null;
  await ensureOptionsSeeded(db, organizationId);
  const key = catalogKey(cleanLabel);
  const existing = await db.get(
    `SELECT id FROM org_options
     WHERE organization_id = ? AND kind = 'department' AND key = ? AND archived_at IS NULL`,
    [organizationId, key]
  );
  if (existing) return getOption(db, organizationId, existing.id);

  return createOption(db, organizationId, 'department', { label: cleanLabel, key });
}

export function countsAs(statusKey, statusOptions = []) {
  const validation = validateStatus(statusKey, statusOptions);
  if (!validation.valid) return 'unknown';
  const meta = validation.option?.meta || parseMetaJson(validation.option?.metaJson);
  return meta.countsAs || validation.key;
}

export function parseMetaJson(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function getOption(db, organizationId, optionId) {
  const row = await db.get(`
    SELECT id, kind, key, label, sort_order AS "sortOrder", archived_at AS "archivedAt", meta_json AS "metaJson"
    FROM org_options
    WHERE id = ? AND organization_id = ?
  `, [optionId, organizationId]);
  return row ? decorateOption(row) : null;
}

async function getCustomField(db, organizationId, fieldId) {
  const row = await db.get(`
    SELECT id, entity, key, label, type, options_json AS "optionsJson", required,
           sort_order AS "sortOrder", archived_at AS "archivedAt"
    FROM custom_field_defs
    WHERE id = ? AND organization_id = ?
  `, [fieldId, organizationId]);
  return row ? decorateCustomField(row) : null;
}

async function insertOption(tx, organizationId, kind, seed) {
  await tx.run(`
    INSERT INTO org_options (id, organization_id, kind, key, label, sort_order, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    randomUUID(),
    organizationId,
    kind,
    seed.key,
    seed.label,
    seed.sortOrder ?? 0,
    JSON.stringify(seed.meta || {})
  ]);
}

async function nextSortOrder(db, organizationId, kind) {
  const row = await db.get(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM org_options WHERE organization_id = ? AND kind = ?',
    [organizationId, kind]
  );
  return row?.next ?? 0;
}

async function nextCustomFieldSortOrder(db, organizationId, entity) {
  const row = await db.get(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM custom_field_defs WHERE organization_id = ? AND entity = ?',
    [organizationId, entity]
  );
  return row?.next ?? 0;
}

function decorateOption(row) {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    label: row.label,
    sortOrder: row.sortOrder ?? 0,
    archivedAt: row.archivedAt || null,
    meta: parseMetaJson(row.metaJson)
  };
}

function decorateCustomField(row) {
  let options = [];
  try {
    options = JSON.parse(row.optionsJson || '[]');
    if (!Array.isArray(options)) options = [];
  } catch {
    options = [];
  }
  return {
    id: row.id,
    entity: row.entity,
    key: row.key,
    label: row.label,
    type: row.type,
    options,
    required: Boolean(row.required),
    sortOrder: row.sortOrder ?? 0,
    archivedAt: row.archivedAt || null
  };
}

function catalogKey(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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
