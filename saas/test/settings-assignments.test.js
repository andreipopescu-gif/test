import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saasDir = join(__dirname, '..');

test('organization settings drive import exclusions and stay isolated', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const alpha = await api.register('Settings Alpha');
    const beta = await api.register('Settings Beta');

    await api.put('/api/settings', alpha.token, {
      excludedEmails: ['skip.me@alpha.test']
    });
    const alphaSettings = await api.get('/api/settings', alpha.token);
    assert.deepEqual(alphaSettings.excludedEmails, ['skip.me@alpha.test']);
    assert.deepEqual((await api.get('/api/settings', beta.token)).excludedEmails, []);

    const csv = [
      'Device ID,Device name,Serial number,Primary user UPN,Primary user display name,Manufacturer,Model,OS,Last check-in',
      'd1,PC-1,SN-SETTINGS-1,skip.me@alpha.test,Skip Me,Lenovo,T14,Windows,2026-01-01'
    ].join('\n');

    const alphaPreview = await api.preview(alpha.token, csv);
    const betaPreview = await api.preview(beta.token, csv);
    assert.equal(alphaPreview.rows[0].person, null);
    assert.equal(betaPreview.rows[0].person?.email, 'skip.me@alpha.test');
  });
});

test('reassigning a device writes an assignment history row', { timeout: 20_000 }, async () => {
  await withServer(async (api, { dbPath, env }) => {
    const admin = await api.register('History Co');
    const ana = await api.post('/api/people', admin.token, {
      firstName: 'Ana', lastName: 'Popescu', email: 'ana@history.test'
    });
    const dan = await api.post('/api/people', admin.token, {
      firstName: 'Dan', lastName: 'Istrate', email: 'dan@history.test'
    });
    const laptop = await api.post('/api/assets', admin.token, {
      assetTag: 'H-1', serialNumber: 'H-SN-1', personId: ana.id
    });
    await api.put(`/api/assets/${laptop.id}`, admin.token, { personId: dan.id });
    await api.put(`/api/assets/${laptop.id}`, admin.token, { personId: '' });

    // Open a direct sqlite/postgres check through the public API's audit trail
    // and the denormalised person_id, then count assignment rows via a second
    // server-side probe using the same database file/url.
    const probe = await openProbe(env, dbPath);
    try {
      const rows = await probe.all(
        'SELECT person_id AS "personId", ended_at AS "endedAt", end_reason AS "endReason" FROM asset_assignments WHERE asset_id = ? ORDER BY started_at, id',
        [laptop.id]
      );
      assert.equal(rows.length, 2);
      assert.equal(rows[0].personId, ana.id);
      assert.ok(rows[0].endedAt);
      assert.equal(rows[0].endReason, 'reassign');
      assert.equal(rows[1].personId, dan.id);
      assert.ok(rows[1].endedAt);
      assert.equal(rows[1].endReason, 'return');
      const asset = await probe.get(
        'SELECT person_id AS "personId", status FROM assets WHERE id = ?',
        [laptop.id]
      );
      assert.equal(asset.personId, null);
      assert.equal(asset.status, 'in_stock');
    } finally {
      await probe.close();
    }
  });
});

async function openProbe(env, dbPath) {
  const { openDatabase } = await import('../src/db.js');
  return openDatabase({
    dbPath,
    databaseUrl: env.DATABASE_URL || ''
  });
}

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-settings-'));
  const port = 21_000 + Math.floor(Math.random() * 1_500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = join(dir, 'saas.sqlite');
  const env = {
    ...process.env,
    NODE_ENV: '',
    SAAS_ALLOW_REGISTRATION: 'true',
    SAAS_REGISTRATION_TOKEN: '',
    SAAS_PUBLIC_URL: '',
    PORT: String(port),
    HOST: '127.0.0.1',
    SAAS_DB_PATH: dbPath,
    SAAS_JWT_SECRET: 'settings-test-secret',
    // Prefer SQLite for this suite unless a caller forced Postgres.
    DATABASE_URL: process.env.DATABASE_URL || ''
  };
  if (!env.DATABASE_URL) delete env.DATABASE_URL;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: saasDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const api = buildClient(baseUrl);
  try {
    await waitForHealth(baseUrl);
    await run(api, { dbPath, env });
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
  return {
    raw,
    get: (path, token) => json('GET', path, token),
    post: (path, token, body) => json('POST', path, token, body),
    put: (path, token, body) => json('PUT', path, token, body),
    async register(orgName) {
      const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
      const created = await json('POST', '/api/auth/register', '', {
        orgName, email, password: 'password-admin'
      });
      return { ...created, email };
    },
    async preview(token, csv) {
      const form = new FormData();
      form.set('source', 'intune');
      form.set('file', new Blob([csv], { type: 'text/csv' }), 'devices.csv');
      const response = await fetch(`${baseUrl}/api/import/preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`preview failed: ${response.status} ${JSON.stringify(payload)}`);
      return payload;
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
