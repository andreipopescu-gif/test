import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectMtrRegion, shouldSkipImportedUser } from '../src/import/excluded-users.js';
import { mapIntuneRows } from '../src/import/intune-mapper.js';
import { buildImportPreview, applyImport } from '../src/import/importer.js';
import { buildUserImportPreview, applyUserImport } from '../src/import/user-importer.js';
import { InventoryStore } from '../src/store.js';

test('detectMtrRegion identifies RO rooms and BG group tags', () => {
  assert.equal(detectMtrRegion({ email: 'RO_Room_Boardroom@tchibo.ro' }), 'RO');
  assert.equal(detectMtrRegion({ deviceName: 'RO-Room-Tech1' }), 'RO');
  assert.equal(detectMtrRegion({ groupTag: 'MTR-BG', deviceName: 'BG Room Tchibo' }), 'BG');
  assert.equal(detectMtrRegion({ deviceName: 'BG Room Family' }), 'BG');
  assert.equal(detectMtrRegion({ deviceName: 'IT-Laptop-01', email: 'user@tchibo.ro' }), '');
});

test('shouldSkipImportedUser matches vendor and notificari accounts', () => {
  assert.equal(shouldSkipImportedUser({ displayName: 'Albu, Costin (MSG Plaut)' }), true);
  assert.equal(shouldSkipImportedUser({ displayName: 'Cojemeachin, Denis (eSolutions)' }), true);
  assert.equal(shouldSkipImportedUser({ displayName: 'Igor, Pogorevici (Niice)' }), true);
  assert.equal(shouldSkipImportedUser({ displayName: 'Luminita, Klein (Tchibo Brands)' }), true);
  assert.equal(shouldSkipImportedUser({ displayName: 'notificari' }), true);
  assert.equal(shouldSkipImportedUser({ email: 'notificari@tchibo.ro' }), true);
  assert.equal(shouldSkipImportedUser({ displayName: 'Tudorache, Creola (Impressum)' }), true);
  assert.equal(shouldSkipImportedUser({
    displayName: 'GAYDARZHIEV, STEFAN',
    email: 'sg@tchibo.onmicrosoft.com'
  }), true);
  assert.equal(shouldSkipImportedUser({
    displayName: 'Ene, Marian (GM)',
    email: 'marian.ene@tchibo.bg'
  }), true);
  assert.equal(shouldSkipImportedUser({
    displayName: 'Ene, Marian',
    email: 'marian.ene@tchibo.ro'
  }), false);
  assert.equal(shouldSkipImportedUser({ displayName: 'Ana Popescu', email: 'ana.popescu@tchibo.ro' }), false);
});

test('Intune import maps MTR RO/BG into separate categories without people', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-mtr-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = [
      'Device ID,Device name,Serial number,Manufacturer,Model,OS,Group tag,Primary user UPN,Primary user display name',
      'd-ro,RO_Room_Boardroom,PF5LN10E,LENOVO,12WE000BGE,Windows,,RO_Room_Boardroom@tchibo.ro,RO Room Boardroom',
      'd-bg,BG Room Tchibo,PF5VTM52,LENOVO,12WE000BGE,Windows,MTR-BG,user@tchibo.ro,Some User',
      'd-pc,PC-USER,SNPC01,LENOVO,21HES4ND09,Windows,,ana.popescu@tchibo.ro,Ana Popescu'
    ].join('\n');

    const mapped = mapIntuneRows([{
      __line: 2,
      'Device ID': 'd-ro',
      'Device name': 'RO_Room_Boardroom',
      'Serial number': 'PF5LN10E',
      Manufacturer: 'LENOVO',
      Model: '12WE000BGE',
      OS: 'Windows',
      'Primary user UPN': 'RO_Room_Boardroom@tchibo.ro',
      'Primary user display name': 'RO Room Boardroom'
    }, {
      __line: 3,
      'Device ID': 'd-bg',
      'Device name': 'BG Room Tchibo',
      'Serial number': 'PF5VTM52',
      Manufacturer: 'LENOVO',
      Model: '12WE000BGE',
      OS: 'Windows',
      'Group tag': 'MTR-BG',
      'Primary user UPN': 'user@tchibo.ro',
      'Primary user display name': 'Some User'
    }], 'all');
    assert.equal(mapped[0].mtrRegion, 'RO');
    assert.equal(mapped[0].person, null);
    assert.equal(mapped[1].mtrRegion, 'BG');
    assert.equal(mapped[1].person, null);

    const preview = buildImportPreview(store, { originalName: 'intune.csv', buffer: Buffer.from(csv) }, {
      source: 'intune',
      deviceFilter: 'all',
      mode: 'upsert'
    });
    const ro = preview.rows.find((row) => row.serialNumber === 'PF5LN10E');
    const bg = preview.rows.find((row) => row.serialNumber === 'PF5VTM52');
    assert.equal(ro.needsReview, false);
    assert.equal(bg.needsReview, false);
    assert.match(ro.modelLabel, /Teams Room|MTR RO/i);
    assert.match(bg.modelLabel, /Teams Room|MTR BG/i);

    await applyImport(store, preview, 'test');
    const assets = store.listAssets();
    const mtrRo = assets.find((asset) => asset.serialNumber === 'PF5LN10E');
    const mtrBg = assets.find((asset) => asset.serialNumber === 'PF5VTM52');
    assert.equal(mtrRo.category.name, 'MTR RO');
    assert.equal(mtrBg.category.name, 'MTR BG');
    assert.equal(mtrRo.status, 'deployed');
    assert.equal(mtrBg.status, 'deployed');
    assert.equal(mtrRo.currentAssignment, null);
    assert.equal(mtrBg.currentAssignment, null);
    assert.ok(!store.listPeople().some((person) => /RO_Room/i.test(person.email || '')));
    assert.equal(store.dashboard().inStock, store.listAssets().filter((a) => a.status === 'in_stock').length);
    assert.ok(store.dashboard().deployed >= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('user import skips excluded vendors and creates MTR rooms from Entra', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-skip-users-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const csv = [
      'User principal name,Display name,First name,Last name,Department,Job title,Account enabled,Object Id',
      'ana.popescu@tchibo.ro,Ana Popescu,Ana,Popescu,IT,Engineer,Yes,obj-ana',
      'costin.albu@vendor.com,"Albu, Costin (MSG Plaut)",Costin,Albu,Vendor,Consultant,Yes,obj-albu',
      'RO_Room_Boardroom@tchibo.ro,RO Room Boardroom,RO,Room,Rooms,MTR,Yes,abfc1ba5-68f1-4cef-9530-a3fdbfbaff03',
      'RO-Room-Tech1@tchibo.ro,RO Room Tech1,RO,Room,Rooms,MTR,Yes,obj-tech1',
      'notificari@tchibo.ro,notificari,Notificari,-,IT,Mailbox,Yes,obj-notif'
    ].join('\n');
    const preview = buildUserImportPreview(store, { originalName: 'entra.csv', buffer: Buffer.from(csv) }, {
      source: 'entra',
      mode: 'upsert'
    });
    assert.equal(preview.summary.create, 1);
    assert.equal(preview.summary.create_mtr, 2);
    assert.ok(preview.rows.some((row) => row.personEmail.includes('ana.popescu') && row.action === 'create'));
    assert.ok(preview.rows.some((row) => /albu/i.test(row.personName) && row.action === 'skip'));
    assert.ok(preview.rows.some((row) => /notificari/i.test(row.personEmail) && row.action === 'skip'));
    assert.ok(preview.rows.some((row) => /boardroom/i.test(row.personEmail) && row.action === 'create_mtr'));

    const result = await applyUserImport(store, preview, 'test');
    assert.equal(result.summary.created, 1);
    assert.equal(result.summary.create_mtr, 2);
    assert.equal(store.listPeople().length, 1);
    const mtrAssets = store.listAssets().filter((asset) => String(asset.category?.name || '').startsWith('MTR'));
    assert.equal(mtrAssets.length, 2);
    assert.ok(mtrAssets.some((asset) => asset.assetTag === 'RO Room Boardroom' && asset.category.name === 'MTR RO'));
    assert.ok(mtrAssets.every((asset) => asset.status === 'deployed'));
    assert.ok(mtrAssets.some((asset) => /tech1/i.test(asset.assetTag) && asset.importMeta.roomUpn === 'ro-room-tech1@tchibo.ro'));
    assert.equal(store.dashboard().inStock, 0);
    assert.equal(store.dashboard().deployed, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
