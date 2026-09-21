import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { parseCsv } from '../src/import/csv-parser.js';
import { createIntuneStyleZip, extractFirstCsvFromZip } from '../src/import/zip-reader.js';
import { buildImportPreview, applyImport } from '../src/import/importer.js';
import { resolveLenovoMtmPrefix } from '../src/import/lenovo-mtm-map.js';
import { InventoryStore } from '../src/store.js';

test('parse CSV with BOM and semicolon delimiter', () => {
  const parsed = parseCsv('\uFEFFSerial number;Device name\n"ABC;123";Laptop 1\n');
  assert.equal(parsed.delimiter, ';');
  assert.deepEqual(parsed.headers, ['Serial number', 'Device name']);
  assert.equal(parsed.records[0]['Serial number'], 'ABC;123');
});

test('extract first CSV from ZIP', () => {
  const csv = Buffer.from('Serial number,Device name\nABC,Laptop\n');
  const zip = createSimpleZip('devices.csv', csv);
  const extracted = extractFirstCsvFromZip(zip);
  assert.equal(extracted.fileName, 'devices.csv');
  assert.equal(extracted.buffer.toString('utf8'), csv.toString('utf8'));
});

test('extract CSV from Intune-style ZIP with central directory sizes', () => {
  const csv = 'Serial number,Device name\nABC,Laptop\n';
  const zip = createIntuneStyleZip('DevicesWithInventory.csv', csv);
  const extracted = extractFirstCsvFromZip(zip);
  assert.equal(extracted.fileName, 'DevicesWithInventory.csv');
  assert.equal(extracted.buffer.toString('utf8'), csv);
});

test('Intune import stores enrollment date on asset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-enroll-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = [
      'Device ID,Device name,Serial number,Manufacturer,Model,OS,Enrollment date,Primary user email address',
      'dev-1,PC-1,SNENROLL01,LENOVO,21HES4ND09,Windows,2024-03-15,user@test.com'
    ].join('\n');
    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: Buffer.from(csv) }, {
      source: 'intune',
      deviceFilter: 'all',
      mode: 'upsert'
    });
    await applyImport(store, preview, 'test');
    const asset = store.listAssets().find((a) => a.serialNumber === 'SNENROLL01');
    assert.equal(asset?.enrolledAt, '2024-03-15');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('preview and apply Intune import without duplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const buffer = await readFile(new URL('./fixtures/intune-devices-sample.csv', import.meta.url));

    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer }, { source: 'auto', deviceFilter: 'all', mode: 'upsert' });
    assert.equal(preview.source, 'intune');
    assert.equal(preview.summary.create, 3);
    assert.equal(preview.summary.needsReview, 0);
    assert.match(preview.rows[0].modelLabel, /ThinkPad T14 .*Gen 4/);
    assert.equal(preview.rows[1].modelLabel, 'iPhone 15');

    await applyImport(store, preview, 'test');
    assert.equal(store.listAssets().length, 3);
    assert.equal(store.listPeople().length, 2);

    const secondPreview = buildImportPreview(store, { originalName: 'intune.csv', buffer }, { source: 'auto', deviceFilter: 'all', mode: 'upsert' });
    assert.equal(secondPreview.summary.update, 3);
    await applyImport(store, secondPreview, 'test');
    assert.equal(store.listAssets().length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('preview Jamf import and resolve MacBook models', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const buffer = await readFile(new URL('./fixtures/jamf-macbooks-sample.csv', import.meta.url));

    const preview = buildImportPreview(store, { originalName: 'jamf.csv', buffer }, { source: 'auto', deviceFilter: 'macbooks', mode: 'upsert' });
    assert.equal(preview.source, 'jamf');
    assert.equal(preview.summary.create, 2);
    assert.equal(preview.summary.needsReview, 0);
    assert.match(preview.rows[0].modelLabel, /MacBook Air/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Jamf resolves MacBook Pro 16-inch M5 Pro marketing name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-m5-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = [
      'Computer Name,Serial Number,Make,Model,Model Identifier,Asset Tag,Username,Full Name,Email Address,Department,Operating System,Operating System Version,Total RAM MB,Jamf Pro Computer ID',
      'MB-PRO-16,C02M5PRO01,Apple,"MacBook Pro (16-inch, M5 Pro)",Mac17,1,MB-PRO-16,edu,Edu User,edu.user@example.com,IT,macOS,15.5,49152,2001'
    ].join('\n');
    const preview = buildImportPreview(store, { originalName: 'jamf.csv', buffer: Buffer.from(csv) }, {
      source: 'jamf',
      deviceFilter: 'macbooks',
      mode: 'upsert'
    });
    assert.equal(preview.summary.needsReview, 0);
    assert.match(preview.rows[0].modelText, /MacBook Pro \(16-inch, M5 Pro\)/);
    assert.match(preview.rows[0].modelLabel, /MacBook Pro 16/);
    assert.match(preview.rows[0].modelLabel, /M5 Pro/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve broad Lenovo MTM prefixes', () => {
  assert.deepEqual(resolveLenovoMtmPrefix('21HES4ND09'), { prefix: '21HE', name: 'ThinkPad T14', generation: 'Gen 4' });
  assert.deepEqual(resolveLenovoMtmPrefix('21ML0001US'), { prefix: '21ML', name: 'ThinkPad T14', generation: 'Gen 5' });
  assert.deepEqual(resolveLenovoMtmPrefix('21KC00A7US'), { prefix: '21KC', name: 'ThinkPad X1 Carbon', generation: 'Gen 12' });
  assert.deepEqual(resolveLenovoMtmPrefix('21JK0053US'), { prefix: '21JK', name: 'ThinkPad E14', generation: 'Gen 5' });
  assert.deepEqual(resolveLenovoMtmPrefix('21QDS5DU0H'), { prefix: '21QD', name: 'ThinkPad T14', generation: 'Gen 6' });
  assert.deepEqual(resolveLenovoMtmPrefix('21RLS5FP0H'), { prefix: '21RL', name: 'ThinkPad X13', generation: 'Gen 6' });
  assert.deepEqual(resolveLenovoMtmPrefix('20HES1KY05'), { prefix: '20HE', name: 'ThinkPad T470', generation: 'Standard' });
  assert.deepEqual(resolveLenovoMtmPrefix('21BQS1PW07'), { prefix: '21BQ', name: 'ThinkPad X13', generation: 'Gen 3' });
});

test('Intune import does not fuzzy-match unknown MTM to X1 2-in-1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = Buffer.from([
      'Device ID,Device Name,Serial Number,Manufacturer,Model,Operating system,OS Version,Primary user UPN',
      'd1,LEN-1,PF-LEN,LENOVO,21QDS5DU0H,Windows,11,user@example.com'
    ].join('\n'));

    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: csv }, { source: 'auto', deviceFilter: 'laptops', mode: 'upsert' });
    assert.match(preview.rows[0].modelLabel, /ThinkPad T14 .*Gen 6/);
    assert.equal(preview.rows[0].modelMatch, 'auto');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Intune import resolves iPhone models without OS column and human-readable names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = Buffer.from([
      'Device ID,Serial number,Manufacturer,Model,OS',
      'd1,IPH-14,Apple,iPhone 14,',
      'd2,IPH-16E,Apple,iPhone 16e,iOS',
      'd3,IPH-SE,Apple,"iPhone SE (3rd generation)",iOS',
      'd4,IPH-PM,Apple,iPhone 15 Pro Max,iOS',
      'd5,IPH-11,Apple,"iPhone15,4",iOS',
      'd6,PIX-7,Google,Pixel 7,Android',
      'd7,XIA-1,Xiaomi,2409BRN2CY,Android'
    ].join('\n'));

    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: csv }, { source: 'intune', deviceFilter: 'all', mode: 'upsert' });
    const bySerial = Object.fromEntries(preview.rows.map((row) => [row.serialNumber, row]));
    assert.equal(bySerial['IPH-14'].modelLabel, 'iPhone 14');
    assert.equal(bySerial['IPH-14'].modelMatch, 'auto');
    assert.equal(bySerial['IPH-16E'].modelLabel, 'iPhone 16e');
    assert.equal(bySerial['IPH-SE'].modelLabel, 'iPhone SE');
    assert.equal(bySerial['IPH-PM'].modelLabel, 'iPhone 15 Pro Max');
    assert.equal(bySerial['IPH-11'].modelLabel, 'iPhone 15');
    assert.equal(bySerial['PIX-7'].modelLabel, 'Pixel 7');
    assert.equal(bySerial['XIA-1'].modelLabel, '2409BRN2CY');
    assert.equal(preview.summary.needsReview, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('import apply updates existing asset when serial matches but preview said create', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const model = store.listCatalog().models.find((m) => m.name === 'ThinkPad T14');
    await store.createAsset({ assetTag: 'ROW-OLD', serialNumber: 'PF-LEN99', modelId: model.id }, 'test');

    const csv = Buffer.from([
      'Device ID,Device name,Serial number,Manufacturer,Model,OS',
      'd1,ROW-NEW,PF-LEN99,LENOVO,21HES4ND09,Windows'
    ].join('\n'));
    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: csv }, { source: 'intune', deviceFilter: 'all', mode: 'upsert' });
    assert.equal(preview.rows[0].action, 'update');
    await applyImport(store, preview, 'test');
    assert.equal(store.listAssets().length, 1);
    assert.equal(store.listAssets()[0].assetTag, 'ROW-NEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('import apply updates existing asset when only asset tag matches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const model = store.listCatalog().models.find((m) => m.name === 'ThinkPad T14');
    await store.createAsset({ assetTag: 'BGW-GM03V58C', serialNumber: 'OLD-SERIAL', modelId: model.id }, 'test');

    const preview = {
      fileName: 'manual.csv',
      rows: [{
        rowKey: 'intune:GM03V58C',
        action: 'create',
        intendedAction: 'create',
        needsReview: false,
        modelId: model.id,
        source: 'intune',
        normalized: {
          source: 'intune',
          serialNumber: 'GM03V58C',
          assetTag: 'BGW-GM03V58C',
          externalId: 'dev-89',
          manufacturer: 'LENOVO',
          model: '21BQS1PW07',
          os: 'Windows',
          person: null
        }
      }],
      modelOverrides: {}
    };
    await applyImport(store, preview, 'test');
    assert.equal(store.listAssets().length, 1);
    assert.equal(store.listAssets()[0].serialNumber, 'GM03V58C');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Intune import infers iOS when OS column is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = Buffer.from('Device ID,Serial number,Manufacturer,Model\nx,IPH-1,Apple,iPhone 14\n');
    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: csv }, { source: 'intune', deviceFilter: 'all', mode: 'upsert' });
    assert.equal(preview.rows[0].modelLabel, 'iPhone 14');
    assert.equal(preview.rows[0].modelMatch, 'auto');
    assert.equal(preview.rows[0].normalized.os, 'iOS');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Intune import resolves iPhone when brand is named Apple', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const iphoneBrand = store.db.catalog.brands.find((b) => b.name === 'Apple iPhone');
    iphoneBrand.name = 'Apple';

    const csv = Buffer.from('Device ID,Serial number,Manufacturer,Model,OS\nx,IPH-1,Apple,iPhone 14,iOS\n');
    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: csv }, { source: 'intune', deviceFilter: 'all', mode: 'upsert' });
    assert.equal(preview.rows[0].modelLabel, 'iPhone 14');
    assert.equal(preview.rows[0].modelMatch, 'auto');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Intune import accepts alternate header casing and filters laptops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = Buffer.from([
      'Device ID,Device Name,Serial Number,Manufacturer,Model,Operating system,OS Version,Primary user UPN',
      'd1,LEN-1,PF-LEN,LENOVO,21HES4ND09,Windows,11,user@example.com',
      'd2,IPH-1,PF-IPH,Apple,"iPhone15,4",iOS,18,user@example.com'
    ].join('\n'));

    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: csv }, { source: 'auto', deviceFilter: 'laptops', mode: 'upsert' });
    assert.equal(preview.summary.total, 2);
    assert.equal(preview.summary.mapped, 1);
    assert.equal(preview.rows[0].serialNumber, 'PF-LEN');
    assert.match(preview.rows[0].modelLabel, /ThinkPad T14 .*Gen 4/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Intune import title-cases names derived from UPN fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = Buffer.from([
      'Device ID,Device Name,Serial Number,Manufacturer,Model,Operating system,OS Version,User Principal Name',
      'd1,LEN-1,PF-LEN,LENOVO,21HES4ND09,Windows,11,rodica.piciorusi@example.com'
    ].join('\n'));

    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: csv }, { source: 'auto', deviceFilter: 'laptops', mode: 'upsert' });
    assert.equal(preview.rows[0].normalized.person.firstName, 'Rodica');
    assert.equal(preview.rows[0].normalized.person.lastName, 'Piciorusi');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Intune import splits common concatenated given names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-import-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = Buffer.from([
      'Device ID,Device Name,Serial Number,Manufacturer,Model,Operating system,OS Version,Primary User Display Name',
      'd1,LEN-1,PF-LEN,LENOVO,21HES4ND09,Windows,11,Gabrielcristinel Ghimici',
      'd2,LEN-2,PF-LEN2,LENOVO,21HES4ND09,Windows,11,Andramihaela Caloian',
      'd3,LEN-3,PF-LEN3,LENOVO,21HES4ND09,Windows,11,Raduionut Bogdan',
      'd4,LEN-4,PF-LEN4,LENOVO,21HES4ND09,Windows,11,Lucretianicoleta Zamfir'
    ].join('\n'));

    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: csv }, { source: 'auto', deviceFilter: 'laptops', mode: 'upsert' });
    assert.equal(preview.rows[0].normalized.person.firstName, 'Gabriel Cristinel');
    assert.equal(preview.rows[0].normalized.person.lastName, 'Ghimici');
    assert.equal(preview.rows[1].normalized.person.firstName, 'Andra Mihaela');
    assert.equal(preview.rows[2].normalized.person.firstName, 'Radu Ionut');
    assert.equal(preview.rows[3].normalized.person.firstName, 'Lucretia Nicoleta');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function createSimpleZip(fileName, content) {
  const name = Buffer.from(fileName);
  const compressed = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  return Buffer.concat([local, name, compressed]);
}
