import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import {
  ensureCatalogSeeded,
  listCatalog,
  resetDefaults,
  resolveGenericModel,
  deleteModel
} from '../src/catalog.js';
import {
  ensureOptionsSeeded,
  listOptions,
  createOption,
  countsAs,
  ensureDepartmentOption,
  validateStatus,
  DEFAULT_STATUSES
} from '../src/options.js';
import { parseCsv } from '../../src/import/csv-parser.js';
import { detectPreset, getPreset, listPresets, scorePreset } from '../src/import/mdm-presets.js';
import { applyMapping, headerSignature, suggestMapping } from '../src/import/column-mapper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(__dirname, '..', '..', 'test', 'fixtures', 'mdm');

test('catalog seeds from saas seed without MTR categories', async () => {
  await withDb(async (db, orgId) => {
    await ensureCatalogSeeded(db, orgId);
    const catalog = await listCatalog(db, orgId);
    assert.ok(catalog.categories.every((item) => item.sortOrder >= 0));
    assert.ok(!catalog.categories.some((item) => item.name === 'MTR RO' || item.name === 'MTR BG'));
    assert.ok(catalog.models.some((model) => model.name.startsWith('ThinkPad')));
  });
});

test('catalog delete archives models referenced by assets', async () => {
  await withDb(async (db, orgId) => {
    await ensureCatalogSeeded(db, orgId);
    const model = (await listCatalog(db, orgId)).models[0];

    await db.run(`
      INSERT INTO assets (
        id, organization_id, asset_tag, serial_number, model_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'in_stock', ?, ?)
    `, [randomUUID(), orgId, 'T-1', 'T-SN-1', model.id, now(), now()]);

    const result = await deleteModel(db, orgId, model.id);
    assert.equal(result.archived, true);
    const archived = await listCatalog(db, orgId, { includeArchived: true });
    assert.ok(archived.models.some((item) => item.id === model.id && item.archivedAt));
  });
});

test('resetDefaults merges missing seed entries without overwriting', async () => {
  await withDb(async (db, orgId) => {
    await ensureCatalogSeeded(db, orgId);
    const before = (await listCatalog(db, orgId)).models.length;
    await db.run('DELETE FROM catalog_models WHERE organization_id = ?', [orgId]);
    const reset = await resetDefaults(db, orgId);
    assert.ok(reset.added.models > 0);
    const after = (await listCatalog(db, orgId)).models.length;
    assert.ok(after >= before);
  });
});

test('resolveGenericModel matches manufacturer and model tokens', async () => {
  await withDb(async (db, orgId) => {
    await ensureCatalogSeeded(db, orgId);
    const catalog = await listCatalog(db, orgId);
    const match = resolveGenericModel(catalog, {
      manufacturer: 'Lenovo',
      model: 'ThinkPad T14 Gen 4',
      modelIdentifier: ''
    });
    assert.ok(match.model);
    assert.match(match.model.name, /ThinkPad T14/i);
  });
});

test('options seed defaults and department auto-create', async () => {
  await withDb(async (db, orgId) => {
    await ensureOptionsSeeded(db, orgId);
    const statuses = await listOptions(db, orgId, 'status');
    assert.equal(statuses.length, DEFAULT_STATUSES.length);
    assert.equal(countsAs('in_stock', statuses), 'inventory');
    assert.equal(countsAs('assigned', statuses), 'assigned');

    const created = await ensureDepartmentOption(db, orgId, 'Engineering');
    assert.equal(created.label, 'Engineering');
    const departments = await listOptions(db, orgId, 'department');
    assert.ok(departments.some((item) => item.label === 'Engineering'));

    const custom = await createOption(db, orgId, 'location', { label: 'HQ Bucharest' });
    assert.equal(validateStatus('in_stock', statuses).valid, true);
    assert.equal(validateStatus('missing', statuses).valid, false);
    assert.equal(custom.key, 'hq-bucharest');
  });
});

test('mdm presets detect fixture headers', async () => {
  const devicePresets = listPresets('devices').map((preset) => preset.key);
  for (const key of devicePresets) {
    const csv = await readFile(join(fixturesRoot, `${key}.csv`), 'utf8');
    const parsed = parseCsv(csv);
    const detected = detectPreset(parsed.headers, { kind: 'devices' });
    assert.ok(detected, `expected detection for ${key}`);
    assert.equal(detected.key, key, `wrong preset for ${key}`);
    assert.ok(detected.score >= 3, `${key} score ${detected.score}`);
  }

  for (const key of ['google_workspace_users', 'okta_users', 'jumpcloud_users']) {
    const csv = await readFile(join(fixturesRoot, 'users', `${key}.csv`), 'utf8');
    const parsed = parseCsv(csv);
    const detected = detectPreset(parsed.headers, { kind: 'users' });
    assert.equal(detected.key, key);
    assert.ok(detected.score >= 2);
  }
});

test('column mapper normalizes device rows for import preview', async () => {
  const csv = await readFile(join(fixturesRoot, 'kandji.csv'), 'utf8');
  const parsed = parseCsv(csv);
  const suggestion = suggestMapping(parsed.headers, { kind: 'devices' });
  assert.equal(suggestion.presetKey, 'kandji');
  const rows = applyMapping(parsed.records, suggestion.mapping, 'kandji');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].serialNumber, 'C02KAND001');
  assert.equal(rows[0].manufacturer, 'Apple');
  assert.equal(rows[0].person.email, 'ana@example.com');
  assert.equal(headerSignature(parsed.headers).includes('device serial number'), true);
});

async function withDb(run) {
  const dir = await mkdtemp(join(tmpdir(), 'saas-tenant-modules-'));
  const db = await openDatabase(join(dir, 'test.db'));
  const orgId = randomUUID();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', [
    orgId,
    'Test Org',
    `test-${orgId.slice(0, 8)}`,
    now()
  ]);
  try {
    await run(db, orgId);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function now() {
  return new Date().toISOString();
}
