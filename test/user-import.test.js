import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUserImportPreview, applyUserImport } from '../src/import/user-importer.js';
import { InventoryStore } from '../src/store.js';

test('preview and apply Entra user import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-users-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const buffer = await readFile(new URL('./fixtures/entra-users-sample.csv', import.meta.url));

    const preview = buildUserImportPreview(store, { originalName: 'entra-users.csv', buffer }, {
      source: 'entra',
      mode: 'upsert'
    });
    assert.equal(preview.kind, 'users');
    assert.equal(preview.source, 'entra');
    assert.equal(preview.summary.create, 2);
    assert.equal(preview.rows[0].personDepartment, 'IT');
    assert.equal(preview.rows[0].personRole, 'Engineer IT');

    const result = await applyUserImport(store, preview, 'test');
    assert.equal(result.summary.imported, 2);
    assert.equal(store.listPeople().length, 2);

    const ana = store.listPeople().find((person) => person.email.includes('ana.popescu'));
    assert.equal(ana.department, 'IT');
    assert.equal(ana.role, 'Engineer IT');
    assert.equal(ana.phone, '+40721111222');
    assert.equal(ana.location, 'Bucharest');
    assert.equal(ana.externalIds.entraObjectId, 'obj-ana-001');

    const secondPreview = buildUserImportPreview(store, { originalName: 'entra-users.csv', buffer }, {
      source: 'entra',
      mode: 'upsert'
    });
    assert.equal(secondPreview.summary.update, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extract unique users from Intune device export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-intune-users-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = [
      'Device ID,Device name,Serial number,Manufacturer,Model,OS,Primary user UPN,Primary user display name',
      'd1,PC-1,SN1,LENOVO,21HES4ND09,Windows,ana.popescu@tchibo.com,ana popescu',
      'd2,PC-2,SN2,LENOVO,21HES4ND09,Windows,ana.popescu@tchibo.com,Ana Popescu',
      'd3,IPH-1,SN3,Apple,iPhone 15,iOS,mihai.ionescu@tchibo.com,mihai ionescu'
    ].join('\n');

    const preview = buildUserImportPreview(store, { originalName: 'intune.csv', buffer: Buffer.from(csv) }, {
      source: 'intune_users',
      mode: 'upsert'
    });
    assert.equal(preview.source, 'intune_users');
    assert.equal(preview.summary.mapped, 2);
    assert.equal(preview.summary.create, 2);
    assert.match(preview.rows[0].personName, /Ana Popescu/i);

    await applyUserImport(store, preview, 'test');
    assert.equal(store.listPeople().length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
