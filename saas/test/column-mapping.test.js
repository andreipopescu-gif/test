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

const UNKNOWN_CSV = [
  'S/N,Device,Owner',
  'SN-COL-1,Mapped Laptop,mapper@example.com'
].join('\n');

test('unknown CSV returns needsMapping with headers and suggestion', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Mapping Need ${randomUUID().slice(0, 8)}`);
    const preview = await uploadPreview(api, admin.token, UNKNOWN_CSV, {
      source: 'auto',
      fileName: 'unknown-headers.csv'
    });
    assert.equal(preview.needsMapping, true);
    assert.deepEqual(preview.headers, ['S/N', 'Device', 'Owner']);
    assert.ok(preview.suggestion);
    assert.ok(preview.suggestion.mapping || preview.canonicalFields);
    assert.ok(!preview.batchId);
  });
});

test('mapping + saveAsProfile creates profile and returns preview with batchId', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Mapping Save ${randomUUID().slice(0, 8)}`);
    const first = await uploadPreview(api, admin.token, UNKNOWN_CSV, {
      source: 'auto',
      fileName: 'unknown-headers.csv'
    });
    assert.equal(first.needsMapping, true);

    const profileName = `Custom map ${randomUUID().slice(0, 6)}`;
    const mapping = {
      serialNumber: 'S/N',
      assetTag: 'Device',
      personEmail: 'Owner'
    };
    const preview = await uploadPreview(api, admin.token, UNKNOWN_CSV, {
      source: 'mapped',
      fileName: 'unknown-headers.csv',
      mapping,
      saveAsProfile: profileName,
      headerSignature: first.headerSignature
    });
    assert.ok(!preview.needsMapping, `unexpected needsMapping: ${JSON.stringify(preview)}`);
    assert.ok(preview.batchId);
    assert.ok(preview.rows.length >= 1);
    assert.equal(preview.rows[0].serialNumber, 'SN-COL-1');

    const profiles = await api.get('/api/import/profiles', admin.token);
    assert.ok(profiles.some((item) => item.name === profileName));
    const saved = profiles.find((item) => item.name === profileName);
    assert.equal(saved.mapping.serialNumber, 'S/N');
  });
});

test('re-upload with same headers auto-selects saved profile', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Mapping Auto ${randomUUID().slice(0, 8)}`);
    const first = await uploadPreview(api, admin.token, UNKNOWN_CSV, {
      source: 'auto',
      fileName: 'unknown-headers.csv'
    });
    assert.equal(first.needsMapping, true);

    const profileName = `Auto profile ${randomUUID().slice(0, 6)}`;
    const mapped = await uploadPreview(api, admin.token, UNKNOWN_CSV, {
      source: 'mapped',
      fileName: 'unknown-headers.csv',
      mapping: {
        serialNumber: 'S/N',
        assetTag: 'Device',
        personEmail: 'Owner'
      },
      saveAsProfile: profileName,
      headerSignature: first.headerSignature
    });
    assert.ok(mapped.batchId);
    const profiles = await api.get('/api/import/profiles', admin.token);
    const saved = profiles.find((item) => item.name === profileName);
    assert.ok(saved);

    const again = await uploadPreview(api, admin.token, UNKNOWN_CSV, {
      source: 'auto',
      fileName: 'unknown-headers-again.csv'
    });
    assert.ok(!again.needsMapping, `expected profile auto-detect, got ${JSON.stringify(again)}`);
    assert.ok(again.batchId);
    assert.ok(
      again.profileId === saved.id || again.rows?.[0]?.serialNumber === 'SN-COL-1',
      `expected profileId or mapped rows, got ${JSON.stringify({
        profileId: again.profileId,
        source: again.source,
        row: again.rows?.[0]
      })}`
    );
  });
});

async function uploadPreview(api, token, csv, {
  source = 'auto',
  fileName = 'devices.csv',
  mapping,
  saveAsProfile,
  headerSignature
} = {}) {
  const form = new FormData();
  form.set('source', source);
  form.set('file', new Blob([csv], { type: 'text/csv' }), fileName);
  if (mapping) form.set('mapping', JSON.stringify(mapping));
  if (saveAsProfile) form.set('saveAsProfile', saveAsProfile);
  if (headerSignature) form.set('headerSignature', headerSignature);
  return api.upload('/api/import/preview', token, form);
}

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-mapping-'));
  const port = 28_500 + Math.floor(Math.random() * 1_500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: '',
    SAAS_ALLOW_REGISTRATION: 'true',
    SAAS_REGISTRATION_TOKEN: '',
    SAAS_PUBLIC_URL: '',
    PORT: String(port),
    HOST: '127.0.0.1',
    SAAS_DB_PATH: join(dir, 'saas.sqlite'),
    SAAS_JWT_SECRET: 'mapping-test-secret',
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
  try {
    await waitForHealth(baseUrl);
    await run(buildClient(baseUrl));
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
  const upload = async (path, token, form) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };
  return {
    raw,
    upload,
    get: (path, token) => json('GET', path, token),
    post: (path, token, body) => json('POST', path, token, body),
    async register(orgName) {
      const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
      const created = await json('POST', '/api/auth/register', '', {
        orgName, email, password: 'password-admin'
      });
      return { ...created, email };
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
