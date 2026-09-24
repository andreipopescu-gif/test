import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULE_SETTINGS, evaluateRules, mergeRuleSettings } from '../src/exceptions/rules.js';

const now = new Date('2026-09-24T12:00:00Z');
const daysAgo = (days) => new Date(now.getTime() - days * 86_400_000).toISOString();

function person(id, overrides = {}) {
  return {
    id, firstName: id, lastName: 'Test', email: `${id}@x.test`, status: 'active',
    externalIds: {}, sourcePresence: { entra: { enabled: true } }, ...overrides
  };
}

function asset(id, overrides = {}) {
  return {
    id, assetTag: id, serialNumber: `SN-${id}`, category: 'Laptop', status: 'assigned',
    personId: null, lastSeenAt: daysAgo(1), externalIds: {}, importMeta: { source: 'jamf' },
    sourcePresence: { jamf: { seenAt: daysAgo(1), importedAt: daysAgo(0) } }, ...overrides
  };
}

function rulesFor(snapshot, settings = DEFAULT_RULE_SETTINGS) {
  return evaluateRules(snapshot, settings, now);
}

function keys(findings, rule) {
  return findings.filter((item) => item.ruleKey === rule).map((item) => item.entityId).sort();
}

test('user_active_no_device flags directory users without a live device', () => {
  const findings = rulesFor({
    people: [
      person('ana'),
      person('dan'),
      person('gone', { status: 'inactive' }),
      person('manual', { sourcePresence: {} })
    ],
    assets: [asset('a1', { personId: 'ana' }), asset('old', { personId: 'dan', status: 'retired' })]
  });
  assert.deepEqual(keys(findings, 'user_active_no_device'), ['dan']);
});

test('device_no_owner ignores spares in stock that do not check in', () => {
  const findings = rulesFor({
    people: [],
    assets: [
      asset('live', { status: 'in_stock' }),
      asset('spare', { status: 'in_stock', lastSeenAt: daysAgo(90) }),
      asset('manual', { status: 'in_stock', importMeta: {}, sourcePresence: {}, lastSeenAt: null }),
      asset('reported', {
        status: 'in_stock', lastSeenAt: daysAgo(90),
        sourcePresence: { jamf: { reportedUserEmail: 'x@x.test', importedAt: daysAgo(0) } }
      })
    ]
  });
  assert.deepEqual(keys(findings, 'device_no_owner'), ['live', 'reported']);
});

test('disabled_user_has_device is high severity and skips retired devices', () => {
  const findings = rulesFor({
    people: [person('maria', { status: 'inactive' }), person('ana')],
    assets: [
      asset('m1', { personId: 'maria' }),
      asset('m2', { personId: 'maria', status: 'retired' }),
      asset('a1', { personId: 'ana' })
    ]
  });
  const hits = findings.filter((item) => item.ruleKey === 'disabled_user_has_device');
  assert.deepEqual(hits.map((item) => item.entityId), ['m1']);
  assert.equal(hits[0].severity, 'high');
});

test('device_stale_checkin honours the threshold and escalates very old devices', () => {
  const findings = rulesFor({
    people: [],
    assets: [
      asset('fresh', { lastSeenAt: daysAgo(3) }),
      asset('stale', { lastSeenAt: daysAgo(40) }),
      asset('ancient', { lastSeenAt: daysAgo(120) }),
      asset('retired', { lastSeenAt: daysAgo(400), status: 'retired' })
    ]
  });
  const stale = findings.filter((item) => item.ruleKey === 'device_stale_checkin');
  assert.deepEqual(stale.map((item) => item.entityId).sort(), ['ancient', 'stale']);
  assert.equal(stale.find((item) => item.entityId === 'ancient').severity, 'high');
  assert.equal(stale.find((item) => item.entityId === 'stale').severity, 'medium');

  const relaxed = rulesFor({ people: [], assets: [asset('stale', { lastSeenAt: daysAgo(40) })] },
    mergeRuleSettings({ staleDays: 60 }));
  assert.equal(keys(relaxed, 'device_stale_checkin').length, 0);
});

test('device_missing_from_mdm follows the import flag', () => {
  const findings = rulesFor({
    people: [],
    assets: [
      asset('gone', { importMeta: { source: 'jamf', missingFromLastImport: true } }),
      asset('here')
    ]
  });
  assert.deepEqual(keys(findings, 'device_missing_from_mdm'), ['gone']);
});

test('owner_mismatch compares the MDM user with the assignment, including alternate addresses', () => {
  const findings = rulesFor({
    people: [
      person('ana', { externalIds: { alternateEmails: ['a.pop@x.test'] } }),
      person('dan')
    ],
    assets: [
      asset('same', { personId: 'ana', sourcePresence: { jamf: { reportedUserEmail: 'ana@x.test', importedAt: 'x' } } }),
      asset('alias', { personId: 'ana', sourcePresence: { jamf: { reportedUserEmail: 'a.pop@x.test', importedAt: 'x' } } }),
      asset('other', { personId: 'ana', sourcePresence: { jamf: { reportedUserEmail: 'dan@x.test', importedAt: 'x' } } })
    ]
  });
  const hits = findings.filter((item) => item.ruleKey === 'owner_mismatch');
  assert.deepEqual(hits.map((item) => item.entityId), ['other']);
  assert.equal(hits[0].details.reportedPerson.id, 'dan');
});

test('duplicate_device catches a shared MDM id and too many devices of one category', () => {
  const findings = rulesFor({
    people: [person('ioana')],
    assets: [
      asset('x1', { externalIds: { jamfComputerId: '42' } }),
      asset('x2', { externalIds: { jamfComputerId: '42' } }),
      asset('l1', { personId: 'ioana' }),
      asset('l2', { personId: 'ioana' }),
      asset('p1', { personId: 'ioana', category: 'Phone' })
    ]
  });
  const dupes = findings.filter((item) => item.ruleKey === 'duplicate_device');
  assert.equal(dupes.length, 2);
  assert.ok(dupes.some((item) => item.details.reason === 'same_external_id'));
  assert.ok(dupes.some((item) => item.details.reason === 'same_person_same_category' && item.details.category === 'Laptop'));
});

test('fingerprints are stable and disabled rules produce nothing', () => {
  const snapshot = { people: [person('dan')], assets: [] };
  const first = rulesFor(snapshot);
  const second = rulesFor(snapshot);
  assert.deepEqual(first.map((item) => item.fingerprint), second.map((item) => item.fingerprint));
  const off = rulesFor(snapshot, mergeRuleSettings({ enabled: { user_active_no_device: false } }));
  assert.equal(off.length, 0);
});
