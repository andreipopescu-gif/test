import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InventoryStore } from '../src/store.js';
import { shouldSkipImportedUser, setRuntimeExcludedUsers } from '../src/import/excluded-users.js';
import { setRuntimeIdentityGroups, emailsAreKnownSamePerson } from '../src/import/known-person-aliases.js';

test('settings merge people delete and reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-settings-'));
  const store = new InventoryStore(join(dir, 'app.db.json'));
  await store.init();

  const a = await store.createPerson({ firstName: 'Ana', lastName: 'Pop', email: 'ana@tchibo.ro' }, 'test');
  const b = await store.createPerson({ firstName: 'Ana', lastName: 'Popescu', email: 'ana.pop@tchibo.ro' }, 'test');
  const modelId = store.listCatalog().models[0].id;
  const asset = await store.createAsset({
    assetTag: 'T1',
    serialNumber: 'S1',
    modelId,
    status: 'in_stock'
  }, 'test');
  await store.reassignAsset(asset.id, { personId: b.id, assignedAt: '2026-01-01', reason: 'test' }, 'test');

  const merged = await store.mergePeopleByIds(a.id, b.id, 'test');
  assert.equal(merged.id, a.id);
  assert.ok(store.getCurrentAssignment(asset.id)?.personId === a.id);
  assert.equal(store.listPeople().some((person) => person.id === b.id), false);

  await store.updateSettings({
    excludedEmails: ['skip.me@tchibo.ro'],
    identityGroups: [{ emails: ['x@tchibo.ro', 'y@tchibo.ro'], firstName: 'X', lastName: 'Y' }],
    handoverOperators: ['Test Operator'],
    modelOverrides: { s1: modelId }
  }, 'test');
  assert.equal(store.getModelOverride('S1'), modelId);
  assert.ok(store.getHandoverOperators().includes('Test Operator'));
  assert.ok(shouldSkipImportedUser({ email: 'skip.me@tchibo.ro' }));
  assert.ok(emailsAreKnownSamePerson('x@tchibo.ro', 'y@tchibo.ro'));

  const empty = await store.createPerson({ firstName: 'Go', lastName: 'Away', email: 'go@tchibo.ro' }, 'test');
  await store.deletePerson(empty.id, 'test');
  assert.equal(store.getPerson(empty.id), null);

  const report = store.buildReportRows('in_stock');
  assert.ok(Array.isArray(report));
  assert.ok(store.listReportTypes().length >= 5);

  setRuntimeExcludedUsers({});
  setRuntimeIdentityGroups([]);
  await rm(dir, { recursive: true, force: true });
});
