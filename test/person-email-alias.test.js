import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  absorbPersonEmails,
  emailsArePersonAliases,
  peopleNamesLikelySame,
  preferCanonicalEmail
} from '../src/utils/person-email-alias.js';
import { InventoryStore } from '../src/store.js';

test('detects angela.popescu vs angelaelena.popescu as aliases', () => {
  assert.equal(
    emailsArePersonAliases('angela.popescu@tchibo.ro', 'angelaelena.popescu@tchibo.ro'),
    true
  );
  assert.equal(
    preferCanonicalEmail('angelaelena.popescu@tchibo.ro', 'angela.popescu@tchibo.ro'),
    'angela.popescu@tchibo.ro'
  );
  assert.equal(
    emailsArePersonAliases('ion.popescu@tchibo.ro', 'ionut.popescu@tchibo.ro'),
    false
  );
});

test('detects edwin.straub vs edwin.straub1 as digit-suffix aliases', async () => {
  const { emailsAreDigitSuffixAliases } = await import('../src/utils/person-email-alias.js');
  assert.equal(
    emailsAreDigitSuffixAliases('edwin.straub@tchibo-external.com', 'edwin.straub1@tchibo-external.com'),
    true
  );
  assert.equal(
    preferCanonicalEmail('edwin.straub1@tchibo-external.com', 'edwin.straub@tchibo-external.com'),
    'edwin.straub@tchibo-external.com'
  );

  const dir = await mkdtemp(join(tmpdir(), 'itinv-straub-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const now = new Date().toISOString();

    store.db.people.push(
      {
        id: 'p-straub1',
        firstName: 'Edwin',
        lastName: 'Straub1',
        department: '',
        role: '',
        email: 'edwin.straub1@tchibo-external.com',
        phone: '',
        manager: '',
        location: '',
        status: 'active',
        notes: '',
        externalIds: {
          upn: 'edwin.straub1@tchibo-external.com',
          jamfUsername: '',
          entraObjectId: '',
          alternateEmails: []
        },
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'p-straub',
        firstName: 'Edwin',
        lastName: 'Straub',
        department: 'adesso',
        role: '',
        email: 'edwin.straub@tchibo-external.com',
        phone: '',
        manager: '',
        location: '',
        status: 'active',
        notes: '',
        externalIds: {
          upn: 'edwin.straub@tchibo-external.com',
          jamfUsername: '',
          entraObjectId: '',
          alternateEmails: []
        },
        createdAt: now,
        updatedAt: now
      }
    );
    store.db.assignments.push({
      id: 'a-straub1',
      assetId: 'asset-straub',
      personId: 'p-straub1',
      startedAt: '2025-01-01',
      endedAt: '',
      endReason: '',
      notes: '',
      createdAt: now,
      updatedAt: now
    });

    const merged = await store.mergeDuplicatePeople('test');
    assert.equal(merged, 1);
    assert.equal(store.db.people.length, 1);
    const person = store.db.people[0];
    assert.equal(person.email, 'edwin.straub@tchibo-external.com');
    assert.equal(person.firstName, 'Edwin');
    assert.equal(person.lastName, 'Straub');
    assert.equal(person.department, 'adesso');
    assert.equal(store.db.assignments[0].personId, person.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('absorbPersonEmails keeps shorter alias as primary', () => {
  const person = {
    email: 'angelaelena.popescu@tchibo.ro',
    externalIds: { upn: 'angelaelena.popescu@tchibo.ro', alternateEmails: [] }
  };
  absorbPersonEmails(person, ['angela.popescu@tchibo.ro']);
  assert.equal(person.email, 'angela.popescu@tchibo.ro');
  assert.ok(person.externalIds.alternateEmails.some((email) =>
    email.toLowerCase() === 'angelaelena.popescu@tchibo.ro'
  ));
});

test('import alias does not create a second person', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-alias-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    store.upsertImportPerson({
      firstName: 'Angela Elena',
      lastName: 'Popescu',
      department: 'IT',
      role: 'Senior IT Recruiter',
      email: 'angela.popescu@tchibo.ro',
      externalIds: { upn: 'angela.popescu@tchibo.ro', entraObjectId: 'obj-angela' }
    }, 'test', new Date().toISOString());

    store.upsertImportPerson({
      firstName: 'Angela Elena',
      lastName: 'Popescu',
      email: 'angelaelena.popescu@tchibo.ro',
      externalIds: { upn: 'angelaelena.popescu@tchibo.ro' }
    }, 'test', new Date().toISOString());

    assert.equal(store.db.people.length, 1);
    const person = store.db.people[0];
    assert.equal(person.email, 'angela.popescu@tchibo.ro');
    assert.equal(person.department, 'IT');
    assert.ok(person.externalIds.alternateEmails.some((email) =>
      email.toLowerCase() === 'angelaelena.popescu@tchibo.ro'
    ));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mergeDuplicatePeople consolidates existing alias rows and reassigns devices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-merge-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const now = new Date().toISOString();

    const primary = {
      id: 'p-primary',
      firstName: 'Angela Elena',
      lastName: 'Popescu',
      department: 'IT',
      role: 'Senior IT Recruiter',
      email: 'angela.popescu@tchibo.ro',
      phone: '',
      manager: '',
      location: '',
      status: 'active',
      notes: '',
      externalIds: {
        upn: 'angela.popescu@tchibo.ro',
        jamfUsername: '',
        entraObjectId: 'obj-angela',
        alternateEmails: []
      },
      createdAt: now,
      updatedAt: now
    };
    const duplicate = {
      id: 'p-dup',
      firstName: 'Angela Elena',
      lastName: 'Popescu',
      department: '',
      role: '',
      email: 'angelaelena.popescu@tchibo.ro',
      phone: '',
      manager: '',
      location: '',
      status: 'active',
      notes: '',
      externalIds: {
        upn: 'angelaelena.popescu@tchibo.ro',
        jamfUsername: '',
        entraObjectId: '',
        alternateEmails: []
      },
      createdAt: now,
      updatedAt: now
    };
    store.db.people.push(primary, duplicate);
    store.db.assignments.push({
      id: 'a1',
      assetId: 'asset-1',
      personId: 'p-dup',
      startedAt: '2026-01-01',
      endedAt: '',
      endReason: '',
      notes: '',
      createdAt: now,
      updatedAt: now
    });

    const merged = await store.mergeDuplicatePeople('test');
    assert.equal(merged, 1);
    assert.equal(store.db.people.length, 1);
    assert.equal(store.db.people[0].email, 'angela.popescu@tchibo.ro');
    assert.equal(store.db.assignments[0].personId, 'p-primary');
    assert.ok(peopleNamesLikelySame(primary, duplicate));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('known name-change aliases merge Onea into Mitincu', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-namechange-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const now = new Date().toISOString();

    store.db.people.push(
      {
        id: 'p-onea',
        firstName: 'Gabriel',
        lastName: 'Onea',
        department: '',
        role: '',
        email: 'gabriel.onea@tchibo.ro',
        phone: '',
        manager: '',
        location: '',
        status: 'active',
        notes: '',
        externalIds: {
          upn: 'gabriel.onea@tchibo.ro',
          jamfUsername: '',
          entraObjectId: '',
          alternateEmails: []
        },
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'p-mitincu',
        firstName: 'Gabriel',
        lastName: 'Mitincu',
        department: 'ITW-E',
        role: '',
        email: 'gabriel.mitincu@tchibo.ro',
        phone: '',
        manager: '',
        location: '',
        status: 'active',
        notes: '',
        externalIds: {
          upn: 'gabriel.mitincu@tchibo.ro',
          jamfUsername: '',
          entraObjectId: 'obj-mitincu',
          alternateEmails: []
        },
        createdAt: now,
        updatedAt: now
      }
    );
    store.db.assignments.push({
      id: 'a-onea',
      assetId: 'asset-x',
      personId: 'p-onea',
      startedAt: '2025-01-01',
      endedAt: '',
      endReason: '',
      notes: '',
      createdAt: now,
      updatedAt: now
    });

    const merged = await store.mergeDuplicatePeople('test');
    assert.equal(merged, 1);
    assert.equal(store.db.people.length, 1);
    const person = store.db.people[0];
    assert.equal(person.email, 'gabriel.mitincu@tchibo.ro');
    assert.equal(person.firstName, 'Gabriel');
    assert.equal(person.lastName, 'Mitincu');
    assert.equal(store.db.assignments[0].personId, person.id);
    assert.ok(person.externalIds.alternateEmails.some((email) =>
      email.toLowerCase() === 'gabriel.onea@tchibo.ro'
    ));

    store.upsertImportPerson({
      firstName: 'Gabriel',
      lastName: 'Onea',
      email: 'gabriel.onea@tchibo.ro',
      externalIds: { upn: 'gabriel.onea@tchibo.ro' }
    }, 'test', now);
    assert.equal(store.db.people.length, 1);
    assert.equal(store.db.people[0].email, 'gabriel.mitincu@tchibo.ro');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('known aliases merge Lucretia Zamfir into Crina email', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-crina-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const now = new Date().toISOString();

    store.db.people.push(
      {
        id: 'p-lucretia',
        firstName: 'Lucretia Nicoleta',
        lastName: 'Zamfir',
        department: '',
        role: '',
        email: 'lucretianicoleta.zamfir@tchibo.ro',
        phone: '',
        manager: '',
        location: '',
        status: 'active',
        notes: '',
        externalIds: {
          upn: 'lucretianicoleta.zamfir@tchibo.ro',
          jamfUsername: '',
          entraObjectId: '',
          alternateEmails: []
        },
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'p-crina',
        firstName: 'Lucretia Nicoleta',
        lastName: 'Zamfir',
        department: 'IT',
        role: 'IT Recruiter',
        email: 'crina.zamfir@tchibo.ro',
        phone: '',
        manager: '',
        location: '',
        status: 'active',
        notes: '',
        externalIds: {
          upn: 'crina.zamfir@tchibo.ro',
          jamfUsername: '',
          entraObjectId: 'obj-crina',
          alternateEmails: []
        },
        createdAt: now,
        updatedAt: now
      }
    );

    const merged = await store.mergeDuplicatePeople('test');
    assert.equal(merged, 1);
    assert.equal(store.db.people.length, 1);
    const person = store.db.people[0];
    assert.equal(person.email, 'crina.zamfir@tchibo.ro');
    assert.equal(person.department, 'IT');
    assert.ok(person.externalIds.alternateEmails.some((email) =>
      email.toLowerCase() === 'lucretianicoleta.zamfir@tchibo.ro'
    ));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
