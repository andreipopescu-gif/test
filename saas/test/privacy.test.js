import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { normalizeRetention, scrubValue } from '../src/privacy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saasDir = join(__dirname, '..');

test('normalizeRetention clamps and fills defaults', () => {
  assert.deepEqual(normalizeRetention({}), {
    previewDays: 7,
    importDays: 30,
    auditDays: 365,
    scrubAppliedImportRows: true
  });
  assert.equal(normalizeRetention({ previewDays: 0, importDays: 3 }).importDays, 7);
  assert.equal(normalizeRetention({ previewDays: 14, importDays: 10 }).importDays, 14);
});

test('scrubValue erases matching emails without touching unrelated rows', () => {
  const emails = new Set(['maria.ionescu@client.example']);
  const personId = 'person-1';
  const scrubbed = scrubValue({
    person: {
      firstName: 'Maria',
      lastName: 'Ionescu',
      email: 'maria.ionescu@client.example',
      department: 'Finance'
    },
    assetTag: 'LAP-1'
  }, emails, personId);
  assert.equal(scrubbed.person.email, '[erased]');
  assert.equal(scrubbed.person.firstName, '[erased]');
  assert.equal(scrubbed.assetTag, 'LAP-1');

  const other = scrubValue({
    person: { email: 'other@client.example', firstName: 'Other' }
  }, emails, personId);
  assert.equal(other.person.email, 'other@client.example');
});

test('deleting a person scrubs import row PII and export omits secrets', { timeout: 30_000 }, async () => {
  await withServer(async (api, { dbPath }) => {
    const admin = await api.register('Privacy Co');
    const person = await api.post('/api/people', admin.token, {
      firstName: 'Maria',
      lastName: 'Ionescu',
      email: 'maria.ionescu@privacy.test',
      department: 'Finance'
    });
    const dan = await api.post('/api/people', admin.token, {
      firstName: 'Dan',
      lastName: 'Pop',
      email: 'dan.pop@privacy.test'
    });

    const dbBefore = await openDatabase({ dbPath });
    try {
      await dbBefore.run(
        'UPDATE people SET manager_email = ? WHERE id = ?',
        ['maria.ionescu@privacy.test', dan.id]
      );
    } finally {
      await dbBefore.close();
    }

    const csv = [
      'Serial number,Device name,Manufacturer,Model,Primary user UPN,Primary user email address,Primary user display name',
      'SN-PRIV-1,Laptop,Lenovo,T14,maria.ionescu@privacy.test,maria.ionescu@privacy.test,Maria Ionescu'
    ].join('\n');
    const form = new FormData();
    form.set('source', 'intune');
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'devices.csv');
    const previewResponse = await fetch(`${api.baseUrl}/api/import/preview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin.token}` },
      body: form
    });
    assert.equal(previewResponse.status, 201);
    const preview = await previewResponse.json();
    assert.ok(preview.batchId);

    const erased = await api.raw('DELETE', `/api/people/${person.id}`, admin.token);
    assert.equal(erased.status, 200);
    const body = await erased.json();
    assert.equal(body.ok, true);
    assert.ok(body.scrubbed.importRows >= 1);

    const people = await api.get('/api/people', admin.token);
    assert.equal(people.find((item) => item.id === person.id), undefined);
    const remainingDan = people.find((item) => item.email === 'dan.pop@privacy.test');
    assert.equal(remainingDan.manager, null);

    const db = await openDatabase({ dbPath });
    try {
      const rows = await db.all(
        'SELECT data_json AS "dataJson" FROM import_rows WHERE organization_id = ?',
        [admin.organization.id]
      );
      assert.ok(rows.length >= 1);
      for (const row of rows) {
        assert.equal(String(row.dataJson).toLowerCase().includes('maria.ionescu@privacy.test'), false);
      }
    } finally {
      await db.close();
    }

    const exported = await api.get('/api/organizations/current/export', admin.token);
    assert.equal(exported.organization.name, 'Privacy Co');
    assert.ok(exported.people.every((item) => item.email !== 'maria.ionescu@privacy.test'));
    assert.ok(Array.isArray(exported.assets));
    assert.ok(exported.connections.every((item) => item.encrypted_credentials === undefined));
    assert.equal(exported.settings.retention.previewDays, 7);

    const retention = await api.put('/api/settings', admin.token, {
      retention: { previewDays: 1, importDays: 2, auditDays: 30, scrubAppliedImportRows: true }
    });
    assert.equal(retention.retention.previewDays, 1);
    assert.equal(retention.retention.importDays, 2);

    const cleanup = await api.post('/api/privacy/retention/run', admin.token, {});
    assert.equal(cleanup.organizations, 1);
  });
});

test('invitation links use a URL fragment', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Invite Hash Co');
    const invitation = await api.post('/api/invitations', admin.token, {
      email: 'guest@invitehash.test',
      role: 'readonly'
    });
    assert.match(invitation.inviteUrl, /#invite=/);
    assert.equal(new URL(invitation.inviteUrl).searchParams.get('invite'), null);
  });
});

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-privacy-'));
  const port = 22_000 + Math.floor(Math.random() * 1_500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(dir, 'saas.sqlite');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: saasDir,
    env: {
      ...process.env,
      NODE_ENV: '',
      SAAS_ALLOW_REGISTRATION: 'true',
      SAAS_REGISTRATION_TOKEN: '',
      SAAS_PUBLIC_URL: '',
      PORT: String(port),
      HOST: '127.0.0.1',
      SAAS_DB_PATH: dbPath,
      SAAS_JWT_SECRET: 'privacy-test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const api = buildClient(baseUrl);
  try {
    await waitForHealth(baseUrl);
    await run(api, { dbPath });
  } catch (error) {
    error.message += `\nServer output:\n${output}`;
    throw error;
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

function buildClient(baseUrl) {
  const raw = (method, path, token, body) => fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const json = async (method, path, token, body) => {
    const response = await raw(method, path, token, body);
    const payload = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };

  return {
    baseUrl,
    raw,
    get: (path, token) => json('GET', path, token),
    post: (path, token, body) => json('POST', path, token, body),
    put: (path, token, body) => json('PUT', path, token, body),
    async register(orgName, password = 'password-admin') {
      const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
      const created = await json('POST', '/api/auth/register', '', { orgName, email, password });
      return { ...created, email, password };
    }
  };
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
