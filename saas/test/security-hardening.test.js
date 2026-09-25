import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { normalizeHttpsBase } from '../src/connectors/mdm/util.js';
import { normalizeJamfBaseUrl } from '../src/connectors/jamf.js';
import { isBlockedHost, normalizeOutboundBaseUrl } from '../src/connectors/url-safety.js';
import { assetsCsv } from '../src/reports.js';
import { hashPassword, verifyPassword } from '../src/auth.js';

test('SSRF denylist blocks metadata and private hosts', () => {
  assert.equal(isBlockedHost('169.254.169.254'), true);
  assert.equal(isBlockedHost('10.0.0.5'), true);
  assert.equal(isBlockedHost('192.168.1.1'), true);
  assert.equal(isBlockedHost('metadata.google.internal'), true);
  assert.equal(isBlockedHost('company.jamfcloud.com'), false);

  assert.throws(
    () => normalizeOutboundBaseUrl('https://169.254.169.254'),
    (error) => error.status === 400
  );
  assert.throws(
    () => normalizeHttpsBase('https://10.1.2.3'),
    (error) => error.status === 400
  );
  assert.throws(
    () => normalizeJamfBaseUrl('https://192.168.0.10'),
    (error) => error.status === 400
  );
  assert.equal(
    normalizeJamfBaseUrl('http://127.0.0.1:9999'),
    'http://127.0.0.1:9999'
  );
});

test('CSV export prefixes spreadsheet formulas', () => {
  const csv = assetsCsv([{
    assetTag: '=CMD()',
    serialNumber: '+1+2',
    status: 'in_stock',
    category: '',
    brand: '',
    modelName: '@SUM(A1)',
    personFirstName: '',
    personLastName: '',
    personEmail: '',
    warrantyEndsOn: ''
  }]);
  assert.match(csv, /"'=CMD\(\)"/);
  assert.match(csv, /"'\+1\+2"/);
  assert.match(csv, /"'@SUM\(A1\)"/);
});

test('password hashes use scrypt with embedded cost params', () => {
  const stored = hashPassword('password-strong-enough');
  assert.match(stored, /^[0-9a-f]+:32768:8:1:[0-9a-f]+$/i);
  assert.equal(verifyPassword('password-strong-enough', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
});

test('legacy salt:hash passwords still verify', () => {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync('legacy-password', salt, 64).toString('hex');
  assert.equal(verifyPassword('legacy-password', `${salt}:${hash}`), true);
});

test('ZIP inflate refuses oversized output', () => {
  const huge = Buffer.alloc(2 * 1024 * 1024, 0x41);
  const compressed = deflateRawSync(huge);
  assert.throws(
    () => inflateRawSync(compressed, { maxOutputLength: 1024 }),
    (error) => Boolean(error)
  );
});
