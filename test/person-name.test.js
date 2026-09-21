import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  formatPersonDisplayName,
  parsePersonDisplayName,
  preferPersonName,
  repairPersonNameFields
} from '../src/utils/person-name.js';
import { mapEntraUserRows } from '../src/import/entra-user-mapper.js';
import { InventoryStore } from '../src/store.js';

test('formatPersonDisplayName splits concatenated given names and title-cases', () => {
  assert.equal(
    formatPersonDisplayName({ firstName: 'adinamihaela', lastName: 'panduru' }),
    'Adina Mihaela Panduru'
  );
  assert.equal(
    formatPersonDisplayName({ firstName: 'andrei', lastName: 'popescu' }),
    'Andrei Popescu'
  );
});

test('parsePersonDisplayName handles Entra Last, First (Dept) format', () => {
  assert.deepEqual(parsePersonDisplayName('Popescu, Angela (IT)'), {
    firstName: 'Angela',
    lastName: 'Popescu',
    department: 'IT'
  });
  assert.deepEqual(parsePersonDisplayName('Fan, Angela Elena (SAT)'), {
    firstName: 'Angela Elena',
    lastName: 'Fan',
    department: 'SAT'
  });
  assert.deepEqual(parsePersonDisplayName('Angela Elena Popescu'), {
    firstName: 'Angela Elena',
    lastName: 'Popescu',
    department: ''
  });
});

test('preferPersonName keeps better name over malformed Entra parse', () => {
  const preferred = preferPersonName(
    { firstName: 'Angela Elena', lastName: 'Popescu' },
    { firstName: 'Popescu,', lastName: 'Angela (IT)' }
  );
  assert.equal(preferred.firstName, 'Angela Elena');
  assert.equal(preferred.lastName, 'Popescu');
});

test('repairPersonNameFields fixes stored Last, First (Dept) rows', () => {
  const person = { firstName: 'Popescu,', lastName: 'Angela (IT)', department: '' };
  assert.equal(repairPersonNameFields(person), true);
  assert.equal(person.firstName, 'Angela');
  assert.equal(person.lastName, 'Popescu');
  assert.equal(person.department, 'IT');
});

test('Entra mapper extracts department from display name parentheses', () => {
  const rows = mapEntraUserRows([{
    __line: 2,
    'User principal name': 'angela.popescu@tchibo.ro',
    'Display name': 'Popescu, Angela (IT)'
  }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].firstName, 'Angela');
  assert.equal(rows[0].lastName, 'Popescu');
  assert.equal(rows[0].department, 'IT');
});

test('store init repairs malformed people and import prefers Intune-style names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-names-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const person = await store.createPerson({
      firstName: 'Popescu,',
      lastName: 'Angela (IT)',
      email: 'angela.popescu@tchibo.ro',
      externalIds: { upn: 'angela.popescu@tchibo.ro' }
    }, 'test');
    assert.equal(person.firstName, 'Popescu,');

    await store.repairMalformedPeople();
    const fixed = store.getPerson(person.id);
    assert.equal(fixed.firstName, 'Angela');
    assert.equal(fixed.lastName, 'Popescu');
    assert.equal(fixed.department, 'IT');

    store.upsertImportPerson({
      email: 'angela.popescu@tchibo.ro',
      firstName: 'Angela Elena',
      lastName: 'Popescu',
      department: 'IT',
      externalIds: { upn: 'angela.popescu@tchibo.ro' }
    }, 'test', new Date().toISOString());
    const merged = store.getPerson(person.id);
    assert.equal(merged.firstName, 'Angela Elena');
    assert.equal(merged.lastName, 'Popescu');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
