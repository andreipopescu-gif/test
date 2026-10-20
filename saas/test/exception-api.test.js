import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mockDevices, mockUsers } from '../src/connectors/mock.js';
import { recordsToCsv } from '../src/connectors/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saasDir = join(__dirname, '..');
const DEMO_RULES = [
  'device_no_owner',
  'device_stale_checkin',
  'disabled_user_has_device',
  'duplicate_device',
  'user_active_no_device'
];

test('the demo connector syncs Entra + Jamf data and every demo issue shows up', { timeout: 60_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Issues ${randomUUID().slice(0, 6)}`);
    await api.put('/api/connections/mock', admin.token, {});
    const sync = await api.post('/api/connections/mock/sync', admin.token, {});
    assert.equal(sync.users.created, 6);
    assert.equal(sync.devices.created, 6);
    assert.ok(sync.exceptions.open >= DEMO_RULES.length);

    const issues = await api.get('/api/exceptions', admin.token);
    assert.deepEqual([...new Set(issues.map((item) => item.ruleKey))].sort(), DEMO_RULES);
    const disabled = issues.find((item) => item.ruleKey === 'disabled_user_has_device');
    assert.equal(disabled.severity, 'high');
    assert.equal(disabled.details.asset.serialNumber, 'C02MOCK003');
    assert.ok(disabled.details.suggestion);

    const summary = await api.get('/api/exceptions/summary', admin.token);
    assert.equal(summary.open, issues.length);

    const detail = await api.get(`/api/assets/${disabled.entityId}`, admin.token);
    assert.equal(detail.sourcePresence.jamf.externalId, '9003');
    assert.ok(detail.lastSeenAt);
    assert.ok(detail.exceptions.some((item) => item.ruleKey === 'disabled_user_has_device'));

    const maria = (await api.get('/api/people', admin.token)).find((person) => person.email === 'maria.stan@demo.example');
    assert.equal(maria.sourcePresence.entra.enabled, false);
    assert.equal(maria.manager, 'Ana Pop');
    const overview = await api.get(`/api/people/${maria.id}/overview`, admin.token);
    assert.equal(overview.assets.length, 1);
    assert.ok(overview.exceptions.some((item) => item.ruleKey === 'disabled_user_has_device'));

    // A second sync with nothing changed must not duplicate anything.
    const again = await api.post('/api/connections/mock/sync', admin.token, {});
    assert.equal(again.exceptions.detected, 0);
    assert.equal((await api.get('/api/exceptions', admin.token)).length, issues.length);
  });
});

test('manual reassignment and a device leaving Jamf raise owner_mismatch and missing_from_mdm', { timeout: 60_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Drift ${randomUUID().slice(0, 6)}`);
    await api.put('/api/connections/mock', admin.token, {});
    await api.post('/api/connections/mock/sync', admin.token, {});
    const people = await api.get('/api/people', admin.token);
    const dan = people.find((person) => person.email === 'dan.ionescu@demo.example');
    const anaDevice = (await api.get('/api/assets', admin.token)).find((asset) => asset.serialNumber === 'C02MOCK001');

    await api.put(`/api/assets/${anaDevice.id}`, admin.token, { personId: dan.id });
    let issues = await api.get('/api/exceptions', admin.token);
    const mismatch = issues.find((item) => item.ruleKey === 'owner_mismatch');
    assert.ok(mismatch, 'owner_mismatch expected after manual reassignment');
    assert.equal(mismatch.details.reportedUserEmail, 'ana.pop@demo.example');
    assert.ok(!issues.some((item) => item.ruleKey === 'user_active_no_device' && item.details.person.id === dan.id));

    await api.put('/api/connections/mock', admin.token, { config: { dropSerials: ['C02MOCK005'] } });
    await api.post('/api/connections/mock/sync', admin.token, {});
    issues = await api.get('/api/exceptions', admin.token);
    const missing = issues.find((item) => item.ruleKey === 'device_missing_from_mdm');
    assert.equal(missing?.details.asset.serialNumber, 'C02MOCK005');
  });
});

test('workflow: assign, snooze, resolve, audit, roles and tenant isolation', { timeout: 60_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Flow ${randomUUID().slice(0, 6)}`);
    const other = await api.register(`Other ${randomUUID().slice(0, 6)}`);
    await api.put('/api/connections/mock', admin.token, {});
    await api.post('/api/connections/mock/sync', admin.token, {});
    const [first, second] = await api.get('/api/exceptions', admin.token);

    const assigned = await api.patch(`/api/exceptions/${first.id}`, admin.token, { action: 'assign' });
    assert.equal(assigned.assigneeUserId, admin.user.id);
    const mine = await api.get(`/api/exceptions?assignee=${admin.user.id}`, admin.token);
    assert.deepEqual(mine.map((item) => item.id), [first.id]);

    const resolved = await api.patch(`/api/exceptions/${first.id}`, admin.token, { action: 'resolve', note: 'Laptop collected' });
    assert.equal(resolved.status, 'resolved');
    assert.deepEqual(resolved.events.map((event) => event.kind), ['detected', 'assigned', 'resolved']);
    assert.equal(resolved.events.at(-1).note, 'Laptop collected');

    const badSnooze = await api.raw('PATCH', `/api/exceptions/${second.id}`, admin.token, { action: 'snooze', until: '2000-01-01' });
    assert.equal(badSnooze.status, 400);
    const snoozed = await api.patch(`/api/exceptions/${second.id}`, admin.token, {
      action: 'snooze', until: new Date(Date.now() + 7 * 86_400_000).toISOString()
    });
    assert.equal(snoozed.status, 'snoozed');

    const audit = await api.get('/api/audit', admin.token);
    assert.ok(audit.some((entry) => entry.action === 'exception.resolve'));

    const readonly = await api.invite(admin.token, 'readonly');
    assert.equal((await api.raw('GET', '/api/exceptions', readonly.token)).status, 200);
    assert.equal((await api.raw('PATCH', `/api/exceptions/${second.id}`, readonly.token, { action: 'resolve' })).status, 403);
    assert.equal((await api.raw('POST', '/api/exceptions/scan', readonly.token, {})).status, 403);
    assert.equal((await api.raw('PUT', '/api/exceptions/rules', readonly.token, { staleDays: 5 })).status, 403);

    assert.equal((await api.get('/api/exceptions', other.token)).length, 0);
    assert.equal((await api.raw('GET', `/api/exceptions/${second.id}`, other.token)).status, 404);
    assert.equal((await api.raw('PATCH', `/api/exceptions/${second.id}`, other.token, { action: 'resolve' })).status, 404);
  });
});

test('rule settings re-check immediately', { timeout: 60_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Rules ${randomUUID().slice(0, 6)}`);
    await api.put('/api/connections/mock', admin.token, {});
    await api.post('/api/connections/mock/sync', admin.token, {});
    const result = await api.put('/api/exceptions/rules', admin.token, {
      staleDays: 60, enabled: { user_active_no_device: false }
    });
    assert.equal(result.settings.staleDays, 60);
    const keys = new Set((await api.get('/api/exceptions', admin.token)).map((item) => item.ruleKey));
    assert.ok(!keys.has('user_active_no_device'));
    assert.ok(!keys.has('device_stale_checkin'));
    assert.ok(keys.has('disabled_user_has_device'));
  });
});

test('CSV import of the same Entra and Jamf data yields the same issues as the connector', { timeout: 60_000 }, async () => {
  await withServer(async (api) => {
    const viaConnector = await api.register(`Conn ${randomUUID().slice(0, 6)}`);
    await api.put('/api/connections/mock', viaConnector.token, {});
    await api.post('/api/connections/mock/sync', viaConnector.token, {});

    const viaCsv = await api.register(`Csv ${randomUUID().slice(0, 6)}`);
    const users = await api.importFile('/api/import/users/preview', viaCsv.token, 'entra', recordsToCsv(mockUsers()), 'entra-users.csv');
    await api.post('/api/import/users/apply', viaCsv.token, { batchId: users.batchId });
    const devices = await api.importFile('/api/import/preview', viaCsv.token, 'jamf', recordsToCsv(mockDevices()), 'jamf.csv');
    const applied = await api.post('/api/import/apply', viaCsv.token, { batchId: devices.batchId });
    assert.ok(applied.exceptions.open > 0);

    const shape = async (token) => (await api.get('/api/exceptions', token))
      .map((item) => `${item.ruleKey}:${item.details.asset?.serialNumber || item.details.person?.email || item.details.reason}`)
      .sort();
    assert.deepEqual(await shape(viaCsv.token), await shape(viaConnector.token));
  });
});

test('live connectors declare least-privilege scopes and refuse credentials without a key', { timeout: 60_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Live ${randomUUID().slice(0, 6)}`);
    const { providers, canStoreCredentials } = await api.get('/api/connections', admin.token);
    assert.equal(canStoreCredentials, false);
    const entra = providers.find((item) => item.key === 'entra');
    const intune = providers.find((item) => item.key === 'intune');
    const jamf = providers.find((item) => item.key === 'jamf');
    const kandji = providers.find((item) => item.key === 'kandji');
    assert.deepEqual(entra.requiredScopes, ['User.Read.All']);
    assert.deepEqual(intune.requiredScopes, ['DeviceManagementManagedDevices.Read.All']);
    assert.ok(jamf.requiredScopes.every((scope) => scope.startsWith('Read')));
    assert.equal(intune.live, true);
    assert.equal(jamf.live, true);
    assert.equal(kandji.live, true);
    assert.ok(providers.filter((item) => item.live).length >= 13);

    const noKey = await api.raw('PUT', '/api/connections/entra', admin.token, {
      credentials: { tenantId: 't', clientId: 'c', clientSecret: 's' }
    });
    assert.equal(noKey.status, 503);
  });
});

test('live Entra sync imports Graph users through the normal pipeline', { timeout: 60_000 }, async () => {
  const graph = await startMockGraph();
  try {
    await withServer(async (api) => {
      const admin = await api.register(`Graph ${randomUUID().slice(0, 6)}`);
      const saved = await api.put('/api/connections/entra', admin.token, {
        credentials: {
          tenantId: 'tenant-live',
          clientId: 'client-live',
          clientSecret: 'secret-live'
        }
      });
      assert.equal(saved.connection.status, 'configured');
      assert.equal(saved.connection.hasCredentials, true);

      const sync = await api.post('/api/connections/entra/sync', admin.token, {});
      assert.equal(sync.users.created, 2);
      assert.ok(sync.exceptions);

      const people = await api.get('/api/people', admin.token);
      const emails = people.map((person) => person.email).sort();
      assert.deepEqual(emails, ['ana.pop@contoso.test', 'maria.stan@contoso.test']);
      const maria = people.find((person) => person.email.startsWith('maria'));
      assert.equal(maria.status, 'inactive');
      assert.equal(maria.sourcePresence.entra.enabled, false);

      const listed = (await api.get('/api/connections', admin.token)).providers.find((item) => item.key === 'entra');
      assert.equal(listed.connection.status, 'connected');
      assert.ok(listed.connection.lastSyncAt);
      assert.equal(listed.connection.lastError, null);
    }, {
      SAAS_CONNECTOR_KEY: 'test-connector-key',
      SAAS_GRAPH_LOGIN_URL: graph.loginBase,
      SAAS_GRAPH_BASE_URL: graph.graphBase
    });
  } finally {
    await graph.close();
  }
});

test('live Intune sync imports managed devices through the normal pipeline', { timeout: 60_000 }, async () => {
  const graph = await startMockGraph();
  try {
    await withServer(async (api) => {
      const admin = await api.register(`Intune ${randomUUID().slice(0, 6)}`);
      await api.put('/api/connections/intune', admin.token, {
        credentials: { tenantId: 'tenant-i', clientId: 'client-i', clientSecret: 'secret-i' }
      });
      const sync = await api.post('/api/connections/intune/sync', admin.token, {});
      assert.equal(sync.devices.created, 1);
      const assets = await api.get('/api/assets', admin.token);
      assert.equal(assets.length, 1);
      assert.equal(assets[0].serialNumber, 'INTUNE001');
      assert.ok(assets[0].sourcePresence?.intune);
      const listed = (await api.get('/api/connections', admin.token)).providers.find((item) => item.key === 'intune');
      assert.equal(listed.connection.status, 'connected');
    }, {
      SAAS_CONNECTOR_KEY: 'test-connector-key',
      SAAS_GRAPH_LOGIN_URL: graph.loginBase,
      SAAS_GRAPH_BASE_URL: graph.graphBase
    });
  } finally {
    await graph.close();
  }
});

test('live Jamf sync imports computers through the normal pipeline', { timeout: 60_000 }, async () => {
  const jamf = await startMockJamf();
  try {
    await withServer(async (api) => {
      const admin = await api.register(`Jamf ${randomUUID().slice(0, 6)}`);
      await api.put('/api/connections/jamf', admin.token, {
        credentials: {
          baseUrl: jamf.baseUrl,
          clientId: 'jamf-client',
          clientSecret: 'jamf-secret'
        }
      });
      const sync = await api.post('/api/connections/jamf/sync', admin.token, {});
      assert.equal(sync.devices.created, 1);
      const assets = await api.get('/api/assets', admin.token);
      assert.equal(assets[0].serialNumber, 'C02JAMF001');
      assert.ok(assets[0].sourcePresence?.jamf);
      const listed = (await api.get('/api/connections', admin.token)).providers.find((item) => item.key === 'jamf');
      assert.equal(listed.connection.status, 'connected');
    }, { SAAS_CONNECTOR_KEY: 'test-connector-key' });
  } finally {
    await jamf.close();
  }
});

test('connector credentials are encrypted at rest when a key is configured', {
  timeout: 60_000,
  skip: process.env.DATABASE_URL ? 'reads the SQLite file directly' : false
}, async () => {
  await withServer(async (api, dbPath) => {
    const admin = await api.register(`Keyed ${randomUUID().slice(0, 6)}`);
    const saved = await api.put('/api/connections/entra', admin.token, {
      credentials: { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'super-secret-value' }
    });
    assert.equal(saved.connection.status, 'configured');
    assert.equal(saved.connection.hasCredentials, true);

    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    const row = raw.prepare('SELECT encrypted_credentials FROM connections WHERE provider = ?').get('entra');
    raw.close();
    assert.ok(row.encrypted_credentials.startsWith('v1.'));
    assert.equal(row.encrypted_credentials.includes('super-secret-value'), false);

    const unknown = await api.raw('PUT', '/api/connections/entra', admin.token, { credentials: { password: 'x' } });
    assert.equal(unknown.status, 400);
  }, { SAAS_CONNECTOR_KEY: 'test-connector-key' });
});

async function withServer(run, extraEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-exceptions-'));
  const port = 26_000 + Math.floor(Math.random() * 1_500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(dir, 'saas.sqlite');
  const env = {
    ...process.env,
    NODE_ENV: '',
    SAAS_ALLOW_REGISTRATION: 'true',
    SAAS_REGISTRATION_TOKEN: '',
    SAAS_PUBLIC_URL: '',
    SAAS_CONNECTOR_KEY: '',
    SAAS_GRAPH_LOGIN_URL: '',
    SAAS_GRAPH_BASE_URL: '',
    PORT: String(port),
    HOST: '127.0.0.1',
    SAAS_DB_PATH: dbPath,
    SAAS_JWT_SECRET: 'exceptions-test-secret',
    ...extraEnv
  };
  // CI's Postgres job sets DATABASE_URL so the same suite covers migration 7
  // and the exception queries on both dialects.
  if (!env.DATABASE_URL) delete env.DATABASE_URL;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: saasDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await waitForHealth(baseUrl);
    await run(buildClient(baseUrl), dbPath);
  } catch (error) {
    error.message += `\nServer output:\n${output}`;
    throw error;
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Tiny stand-in for login.microsoftonline.com + graph.microsoft.com so the
 * live Entra sync path is covered without calling Microsoft.
 */
async function startMockGraph() {
  const { createServer } = await import('node:http');
  const users = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      userPrincipalName: 'ana.pop@contoso.test',
      mail: 'ana.pop@contoso.test',
      displayName: 'Ana Pop',
      givenName: 'Ana',
      surname: 'Pop',
      department: 'Engineering',
      jobTitle: 'Developer',
      accountEnabled: true,
      officeLocation: 'Bucharest',
      mobilePhone: '',
      businessPhones: [],
      manager: { displayName: 'Radu Marin' }
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      userPrincipalName: 'maria.stan@contoso.test',
      mail: 'maria.stan@contoso.test',
      displayName: 'Maria Stan',
      givenName: 'Maria',
      surname: 'Stan',
      department: 'Finance',
      jobTitle: 'Accountant',
      accountEnabled: false,
      officeLocation: '',
      mobilePhone: '',
      businessPhones: [],
      manager: { displayName: 'Ana Pop' }
    }
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && /\/oauth2\/v2\.0\/token$/.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token_type: 'Bearer', expires_in: 3600, access_token: 'mock-graph-token' }));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1.0/users')) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer mock-graph-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ value: users }));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1.0/deviceManagement/managedDevices')) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer mock-graph-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        value: [{
          id: 'intune-device-1',
          deviceName: 'ANA-LAPTOP',
          managedDeviceName: 'ANA-LAPTOP',
          serialNumber: 'INTUNE001',
          manufacturer: 'Microsoft',
          model: 'Surface Laptop',
          operatingSystem: 'Windows',
          osVersion: '11',
          imei: '',
          userPrincipalName: 'ana.pop@contoso.test',
          userDisplayName: 'Ana Pop',
          emailAddress: 'ana.pop@contoso.test',
          deviceCategoryDisplayName: 'Corp',
          lastSyncDateTime: '2026-09-24T08:00:00Z',
          enrolledDateTime: '2025-06-01T00:00:00Z'
        }]
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `No route ${req.method} ${url.pathname}` } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    loginBase: base,
    graphBase: base,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function startMockJamf() {
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api/oauth/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'mock-jamf-token', expires_in: 3600, token_type: 'Bearer' }));
      return;
    }
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer mock-jamf-token') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/JSSResource/computers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ computers: [{ id: 42, name: 'MBP-JAMF' }] }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/JSSResource/computers/id/42') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        computer: {
          general: {
            id: 42,
            name: 'MBP-JAMF',
            serial_number: 'C02JAMF001',
            asset_tag: 'J-1',
            report_date_utc: '2026-09-24T09:00:00Z',
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
        }
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No route ${req.method} ${url.pathname}` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

function buildClient(baseUrl) {
  const raw = (method, path, token = '', body) => fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = async (method, path, token, body) => {
    const response = await raw(method, path, token, body);
    const payload = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
  const client = {
    raw,
    get: (path, token) => json('GET', path, token),
    post: (path, token, body) => json('POST', path, token, body),
    put: (path, token, body) => json('PUT', path, token, body),
    patch: (path, token, body) => json('PATCH', path, token, body),
    async register(orgName) {
      const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
      return json('POST', '/api/auth/register', '', { orgName, email, password: 'password-admin', name: 'Admin' });
    },
    async invite(adminToken, role) {
      const invitation = await json('POST', '/api/invitations', adminToken, {
        email: `${role}-${randomUUID().slice(0, 8)}@example.test`, role
      });
      const token = inviteTokenFromUrl(invitation.inviteUrl);
      return json('POST', '/api/invitations/accept', '', { token, password: 'password-member', name: role });
    },
    async importFile(path, token, source, buffer, fileName) {
      const form = new FormData();
      form.set('source', source);
      form.set('file', new Blob([buffer], { type: 'text/csv' }), fileName);
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${JSON.stringify(payload)}`);
      return payload;
    }
  };
  return client;
}

function inviteTokenFromUrl(inviteUrl) {
  const url = new URL(inviteUrl);
  return url.searchParams.get('invite')
    || new URLSearchParams(String(url.hash || '').replace(/^#/, '')).get('invite')
    || '';
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become healthy');
}
