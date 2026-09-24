import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import {
  listExceptions,
  runExceptionScan,
  saveRuleSettings,
  summarizeExceptions,
  updateException
} from '../src/exceptions/engine.js';

test('scans are idempotent and keyed on fingerprint', async () => {
  await withDb(async (db, orgA) => {
    await addPerson(db, orgA, 'dan');
    const first = await runExceptionScan(db, orgA);
    const second = await runExceptionScan(db, orgA);
    assert.equal(first.detected, 1);
    assert.equal(second.detected, 0);
    assert.equal(second.unchanged, 1);
    const rows = await db.all('SELECT id FROM exceptions WHERE organization_id = ?', [orgA]);
    assert.equal(rows.length, 1);
  });
});

test('fixed conditions auto-resolve and reappearing ones reopen', async () => {
  await withDb(async (db, orgA) => {
    const dan = await addPerson(db, orgA, 'dan');
    await runExceptionScan(db, orgA);
    const assetId = await addAsset(db, orgA, 'L1', { personId: dan });
    const fixed = await runExceptionScan(db, orgA);
    assert.equal(fixed.autoResolved, 1);
    let [item] = await listExceptions(db, orgA, { status: 'resolved' });
    assert.equal(item.resolution, 'auto');

    await db.run('UPDATE assets SET person_id = NULL, status = ? WHERE id = ?', ['retired', assetId]);
    const again = await runExceptionScan(db, orgA);
    assert.equal(again.reopened, 1);
    [item] = await listExceptions(db, orgA, { status: 'open' });
    assert.equal(item.ruleKey, 'user_active_no_device');
    assert.equal(item.resolution, null);
  });
});

test('dismissed exceptions stay dismissed across scans; snoozed ones wake up', async () => {
  await withDb(async (db, orgA, userId) => {
    await addPerson(db, orgA, 'dan');
    await addPerson(db, orgA, 'eve');
    await runExceptionScan(db, orgA);
    const [dan, eve] = (await listExceptions(db, orgA, {})).sort((a, b) =>
      a.details.person.email.localeCompare(b.details.person.email));
    await updateException(db, orgA, dan.id, { action: 'dismiss', note: 'contractor' }, userId);
    await updateException(db, orgA, eve.id, {
      action: 'snooze', until: new Date(Date.now() + 86_400_000).toISOString()
    }, userId);

    await runExceptionScan(db, orgA);
    const statuses = Object.fromEntries((await listExceptions(db, orgA, {})).map((item) => [item.id, item.status]));
    assert.equal(statuses[dan.id], 'dismissed');
    assert.equal(statuses[eve.id], 'snoozed');

    await runExceptionScan(db, orgA, { now: new Date(Date.now() + 2 * 86_400_000) });
    const woke = (await listExceptions(db, orgA, { status: 'open' })).map((item) => item.id);
    assert.deepEqual(woke, [eve.id]);

    const events = await db.all('SELECT kind FROM exception_events WHERE exception_id = ? ORDER BY created_at', [eve.id]);
    assert.deepEqual(events.map((item) => item.kind), ['detected', 'snoozed', 'snooze_expired']);
  });
});

test('organizations never see each other\u2019s exceptions', async () => {
  await withDb(async (db, orgA, userA) => {
    const orgB = await addOrg(db, 'B');
    await addPerson(db, orgA, 'dan');
    await addPerson(db, orgB, 'zoe');
    await addPerson(db, orgB, 'yan');
    await runExceptionScan(db, orgA);
    await runExceptionScan(db, orgB);
    assert.equal((await listExceptions(db, orgA, {})).length, 1);
    assert.equal((await summarizeExceptions(db, orgB)).open, 2);

    const [foreign] = await listExceptions(db, orgB, {});
    await assert.rejects(updateException(db, orgA, foreign.id, { action: 'resolve' }, userA), /not found/i);
  });
});

test('rule settings disable a rule and close its open exceptions', async () => {
  await withDb(async (db, orgA) => {
    await addPerson(db, orgA, 'dan');
    await runExceptionScan(db, orgA);
    await saveRuleSettings(db, orgA, { enabled: { user_active_no_device: false } });
    const result = await runExceptionScan(db, orgA);
    assert.equal(result.autoResolved, 1);
    assert.equal(result.open, 0);
  });
});

async function withDb(run) {
  const dir = await mkdtemp(join(tmpdir(), 'saas-exceptions-'));
  const db = await openDatabase({ dbPath: join(dir, 'test.db'), databaseUrl: '' });
  const orgId = await addOrg(db, 'A');
  const userId = randomUUID();
  await db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, `${userId}@x.test`, 'Tester', 'x', now()]);
  await db.run('INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [randomUUID(), orgId, userId, 'admin', now()]);
  try {
    await run(db, orgId, userId);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function addOrg(db, name) {
  const id = randomUUID();
  await db.run('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)',
    [id, name, `${name.toLowerCase()}-${id.slice(0, 8)}`, now()]);
  return id;
}

async function addPerson(db, orgId, alias) {
  const id = randomUUID();
  await db.run(`
    INSERT INTO people (id, organization_id, first_name, last_name, email, status, source_presence_json, created_at, updated_at)
    VALUES (?, ?, ?, 'Test', ?, 'active', ?, ?, ?)
  `, [id, orgId, alias, `${alias}@x.test`, JSON.stringify({ entra: { enabled: true } }), now(), now()]);
  return id;
}

async function addAsset(db, orgId, tag, { personId = null } = {}) {
  const id = randomUUID();
  await db.run(`
    INSERT INTO assets (id, organization_id, asset_tag, serial_number, status, person_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, orgId, tag, `SN-${tag}`, personId ? 'assigned' : 'in_stock', personId, now(), now()]);
  return id;
}

function now() {
  return new Date().toISOString();
}
