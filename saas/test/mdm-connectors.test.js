import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PROVIDERS } from '../src/connectors/index.js';
import { kandjiProvider, toKandjiExportRow } from '../src/connectors/mdm/kandji.js';
import { jumpcloudProvider } from '../src/connectors/mdm/jumpcloud.js';
import { hexnodeProvider } from '../src/connectors/mdm/hexnode.js';
import { rowFromPreset } from '../src/connectors/mdm/util.js';

test('all MDM presets have a live connector besides generic', () => {
  const keys = PROVIDERS.filter((provider) => provider.live).map((provider) => provider.key);
  for (const expected of [
    'entra', 'intune', 'jamf',
    'kandji', 'mosyle', 'workspace_one', 'google_chromeos',
    'jumpcloud', 'ninjaone', 'manageengine', 'hexnode', 'addigy', 'soti'
  ]) {
    assert.ok(keys.includes(expected), `missing provider ${expected}`);
  }
});

test('rowFromPreset uses primary CSV headers', () => {
  const row = rowFromPreset('kandji', { serialNumber: 'S1', externalId: 'D1' });
  assert.equal(row['Device Serial Number'], 'S1');
  assert.equal(row['Device ID'], 'D1');
});

test('toKandjiExportRow maps API device payloads', () => {
  const row = toKandjiExportRow({
    serial_number: 'C02K1',
    device_name: 'Mac-1',
    model: 'MacBook Pro',
    os_version: '15.0',
    device_id: 'kid-1',
    user: { email: 'a@b.c', name: 'Ana' },
    last_check_in: '2026-09-24T10:00:00Z'
  });
  assert.equal(row['Device Serial Number'], 'C02K1');
  assert.equal(row['Device User Email'], 'a@b.c');
});

test('kandji fetch pages devices from a mock API', async () => {
  const server = await listen(async (req, res) => {
    if (req.headers.authorization !== 'Bearer tok') {
      res.writeHead(401); res.end('{}'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ serial_number: 'S1', device_id: '1', device_name: 'N1' }]));
  });
  try {
    const result = await kandjiProvider.fetch({
      credentials: { baseUrl: server.baseUrl, apiToken: 'tok' },
      fetchImpl: globalThis.fetch
    });
    assert.equal(result.devices.source, 'kandji');
    assert.equal(result.devices.records[0]['Device Serial Number'], 'S1');
  } finally {
    await server.close();
  }
});

test('jumpcloud fetch uses x-api-key', async () => {
  const server = await listen(async (req, res) => {
    assert.equal(req.headers['x-api-key'], 'jc-key');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'sys1', serialNumber: 'JC1', displayName: 'JC-Mac' }]));
  });
  try {
    const result = await jumpcloudProvider.fetch({
      credentials: { apiKey: 'jc-key', baseUrl: server.baseUrl },
      fetchImpl: globalThis.fetch
    });
    assert.equal(result.devices.records[0]['Serial Number'], 'JC1');
  } finally {
    await server.close();
  }
});

test('hexnode fetch maps portal devices', async () => {
  const server = await listen(async (req, res) => {
    assert.equal(req.headers.authorization, 'hex-key');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      results: [{ id: 9, serial_number: 'HX1', device_name: 'Phone', os_name: 'iOS' }]
    }));
  });
  try {
    const result = await hexnodeProvider.fetch({
      credentials: { baseUrl: server.baseUrl, apiKey: 'hex-key' },
      fetchImpl: globalThis.fetch
    });
    assert.equal(result.devices.source, 'hexnode');
    assert.equal(result.devices.records[0]['Serial Number'], 'HX1');
  } finally {
    await server.close();
  }
});

function listen(handler) {
  const server = createServer((req, res) => handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res, rej) => server.close((error) => (error ? rej(error) : res())))
      });
    });
  });
}
