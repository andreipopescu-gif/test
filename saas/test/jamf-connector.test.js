import test from 'node:test';
import assert from 'node:assert/strict';
import { jamfProvider, normalizeJamfBaseUrl, toJamfExportRow } from '../src/connectors/jamf.js';

test('toJamfExportRow matches CSV / demo column names', () => {
  const row = toJamfExportRow({
    general: {
      id: 9001,
      name: 'MBP-ANA',
      serial_number: 'C02MOCK001',
      asset_tag: 'AT-1',
      report_date_utc: '2026-09-24T10:00:00Z',
      last_enrolled_date_utc: '2025-01-01T00:00:00Z'
    },
    hardware: {
      make: 'Apple',
      model: 'MacBook Pro 14',
      model_identifier: 'Mac15,6',
      os_name: 'macOS',
      os_version: '15.4',
      total_ram_mb: 16384
    },
    location: {
      username: 'ana.pop',
      realname: 'Ana Pop',
      email_address: 'ana.pop@demo.example',
      department: 'Engineering'
    }
  });
  assert.equal(row['Serial Number'], 'C02MOCK001');
  assert.equal(row['Jamf Pro Computer ID'], '9001');
  assert.equal(row['Last Check-in'], '2026-09-24T10:00:00Z');
  assert.equal(row['Email Address'], 'ana.pop@demo.example');
});

test('normalizeJamfBaseUrl requires https outside loopback', () => {
  assert.equal(normalizeJamfBaseUrl('company.jamfcloud.com'), 'https://company.jamfcloud.com');
  assert.throws(() => normalizeJamfBaseUrl('http://evil.example'), (error) => error.status === 400);
  assert.equal(normalizeJamfBaseUrl('http://127.0.0.1:9999'), 'http://127.0.0.1:9999');
});

test('jamf fetch lists computers and maps details', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || 'GET' });
    if (href.endsWith('/api/oauth/token')) {
      return jsonResponse({ access_token: 'jamf-tok', expires_in: 3600 });
    }
    if (href.endsWith('/JSSResource/computers')) {
      return jsonResponse({ computers: [{ id: 11, name: 'MBP' }] });
    }
    if (href.endsWith('/JSSResource/computers/id/11')) {
      return jsonResponse({
        computer: {
          general: { id: 11, name: 'MBP', serial_number: 'SN11', report_date_utc: '2026-09-01T12:00:00Z' },
          hardware: { model: 'MacBook Pro', model_identifier: 'Mac15,6', total_ram_mb: 8192 },
          location: { email_address: 'owner@example.test', realname: 'Owner' }
        }
      });
    }
    throw new Error(`unexpected ${href}`);
  };

  const result = await jamfProvider.fetch({
    credentials: {
      baseUrl: 'http://127.0.0.1:9',
      clientId: 'cid',
      clientSecret: 'secret'
    },
    fetchImpl
  });
  assert.equal(result.devices.source, 'jamf');
  assert.equal(result.devices.records.length, 1);
  assert.equal(result.devices.records[0]['Serial Number'], 'SN11');
  assert.ok(calls.some((call) => call.href.includes('/api/oauth/token')));
});

test('jamf fetch requires credentials', async () => {
  await assert.rejects(
    () => jamfProvider.fetch({ credentials: { baseUrl: 'https://x.jamfcloud.com' } }),
    (error) => error.status === 400
  );
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}
