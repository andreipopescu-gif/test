import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportPolicy, emptyImportPolicy } from '../../src/import/import-policy.js';
import { shouldSkipImportedUser, setRuntimeExcludedUsers } from '../../src/import/excluded-users.js';
import { setRuntimeIdentityGroups } from '../../src/import/known-person-aliases.js';
import { mapIntuneRows } from '../../src/import/intune-mapper.js';
import { buildSaasImportPreview } from '../src/import-service.js';

test('two policies answer differently for the same person without resetting globals', () => {
  const skip = createImportPolicy({
    excludedEmails: ['hidden@a.test'],
    excludedNameRules: []
  });
  const keep = emptyImportPolicy();
  const person = { email: 'hidden@a.test', firstName: 'Hidden', lastName: 'User' };

  assert.equal(shouldSkipImportedUser(person, skip), true);
  assert.equal(shouldSkipImportedUser(person, keep), false);
  // Order does not matter: the first call must not poison the second.
  assert.equal(shouldSkipImportedUser(person, skip), true);
});

test('concurrent previews honour per-organization exclusions', () => {
  // This is the failure mode the old setRuntime* path would have: whichever
  // request wrote the globals last decided the exclusion list for both.
  setRuntimeExcludedUsers({ emails: ['poison@global.test'], nameRules: [], useDefaults: false });
  setRuntimeIdentityGroups([], { useDefaults: false });

  const headers = [
    'Device ID', 'Device name', 'Serial number', 'Primary user UPN',
    'Primary user display name', 'Last check-in', 'Manufacturer', 'Model', 'OS'
  ].join(',');
  const csvFor = (email, serial) => Buffer.from([
    headers,
    `dev-1,PC-1,${serial},${email},Someone,2026-01-01,Lenovo,ThinkPad,Windows`
  ].join('\n'));

  const policyA = createImportPolicy({ excludedEmails: ['skip-a@a.test'] });
  const policyB = emptyImportPolicy();

  const previewA = buildSaasImportPreview({
    buffer: csvFor('skip-a@a.test', 'SN-A'),
    fileName: 'a.csv',
    policy: policyA
  });
  const previewB = buildSaasImportPreview({
    buffer: csvFor('skip-a@a.test', 'SN-B'),
    fileName: 'b.csv',
    policy: policyB
  });

  assert.equal(previewA.rows[0].person, null);
  assert.equal(previewB.rows[0].person?.email, 'skip-a@a.test');
  // The poisoned runtime list must not have leaked into either preview either.
  assert.equal(
    shouldSkipImportedUser({ email: 'poison@global.test' }, policyB),
    false
  );
});

test('mapIntuneRows respects an explicit policy while leaving runtime alone', () => {
  setRuntimeExcludedUsers({ emails: [], nameRules: [], useDefaults: false });
  const records = [{
    __line: 2,
    'Device ID': 'd1',
    'Device name': 'PC',
    'Serial number': 'SN-1',
    'Primary user UPN': 'blocked@x.test',
    'Primary user display name': 'Blocked User',
    Manufacturer: 'Lenovo',
    Model: 'T14',
    OS: 'Windows'
  }];
  const withSkip = mapIntuneRows(records, 'all', createImportPolicy({
    excludedEmails: ['blocked@x.test']
  }));
  const withoutSkip = mapIntuneRows(records, 'all', emptyImportPolicy());
  assert.equal(withSkip[0].person, null);
  assert.equal(withoutSkip[0].person?.email, 'blocked@x.test');
});
