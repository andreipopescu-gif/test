import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, access } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saasDir = join(__dirname, '..');
const fixturesRoot = join(__dirname, '..', '..', 'test', 'fixtures', 'mdm');
const intuneFixture = join(__dirname, '..', '..', 'test', 'fixtures', 'intune-devices-sample.csv');
const jamfFixture = join(__dirname, '..', '..', 'test', 'fixtures', 'jamf-macbooks-sample.csv');

test('device MDM fixtures auto-detect to their filename stem via /api/import/preview', { timeout: 60_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`MDM Devices ${randomUUID().slice(0, 8)}`);
    const files = (await readdir(fixturesRoot))
      .filter((name) => name.endsWith('.csv'))
      .sort();
    assert.ok(files.length > 0, 'expected device MDM fixtures');

    for (const fileName of files) {
      const stem = basename(fileName, extname(fileName));
      const csv = await readFile(join(fixturesRoot, fileName));
      const form = new FormData();
      form.set('source', 'auto');
      form.set('file', new Blob([csv], { type: 'text/csv' }), fileName);
      const preview = await api.upload('/api/import/preview', admin.token, form);

      if (preview.needsMapping) {
        assert.equal(preview.needsMapping, false, `${stem} unexpectedly needs mapping`);
      }
      assert.equal(
        preview.source,
        stem,
        `${fileName}: expected source=${stem}, got ${preview.source}`
      );
      assert.ok(preview.batchId, `${stem} missing batchId`);
      assert.ok(Array.isArray(preview.rows), `${stem} missing rows`);
    }
  });
});

test('user MDM fixtures auto-detect via /api/import/users/preview', { timeout: 60_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`MDM Users ${randomUUID().slice(0, 8)}`);
    const usersDir = join(fixturesRoot, 'users');
    const files = (await readdir(usersDir))
      .filter((name) => name.endsWith('.csv'))
      .sort();
    assert.ok(files.length > 0, 'expected user MDM fixtures');

    for (const fileName of files) {
      const stem = basename(fileName, extname(fileName));
      const csv = await readFile(join(usersDir, fileName));
      const form = new FormData();
      form.set('source', 'auto');
      form.set('file', new Blob([csv], { type: 'text/csv' }), fileName);
      const preview = await api.upload('/api/import/users/preview', admin.token, form);

      if (preview.needsMapping) {
        assert.equal(preview.needsMapping, false, `${stem} unexpectedly needs mapping`);
      }
      assert.equal(preview.source, stem, `${fileName}: expected source=${stem}, got ${preview.source}`);
      assert.equal(preview.kind, 'users');
      assert.ok(preview.batchId, `${stem} missing batchId`);
    }
  });
});

test('renamed headers return needsMapping:true', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`MDM Mapping ${randomUUID().slice(0, 8)}`);
    const csv = [
      'S/N,Device,Owner',
      'SN-MAP-1,Laptop One,owner@example.com'
    ].join('\n');
    const form = new FormData();
    form.set('source', 'auto');
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'renamed.csv');
    const preview = await api.upload('/api/import/preview', admin.token, form);
    assert.equal(preview.needsMapping, true);
    assert.ok(Array.isArray(preview.headers));
    assert.ok(preview.headers.includes('S/N'));
    assert.ok(!preview.batchId);
  });
});

test('Intune fixture auto-detects when present; otherwise uses minimal Intune-like CSV', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`MDM Intune ${randomUUID().slice(0, 8)}`);
    let csv;
    let fileName;
    const hasFixture = await fileExists(intuneFixture);
    if (hasFixture) {
      csv = await readFile(intuneFixture);
      fileName = 'intune-devices-sample.csv';
    } else {
      // No checked-in Intune sample under test/fixtures — use headers from detect-source.js.
      csv = Buffer.from([
        'Device ID,Device name,Serial number,Primary user UPN,Last check-in',
        'i1,PC-1,SN-INTUNE-1,ana@example.com,2026-01-01'
      ].join('\n'));
      fileName = 'intune-minimal.csv';
    }

    const form = new FormData();
    form.set('source', 'auto');
    form.set('file', new Blob([csv], { type: 'text/csv' }), fileName);
    const preview = await api.upload('/api/import/preview', admin.token, form);
    assert.equal(preview.source, 'intune');
    assert.ok(!preview.needsMapping);
    assert.ok(preview.batchId);
  });
});

test('Jamf fixture path still works when available', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`MDM Jamf ${randomUUID().slice(0, 8)}`);
    const hasFixture = await fileExists(jamfFixture);
    if (!hasFixture) {
      // Skip when jamf sample is absent from the workspace fixtures.
      return;
    }
    const csv = await readFile(jamfFixture);
    const form = new FormData();
    form.set('source', 'auto');
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'jamf-macbooks-sample.csv');
    const preview = await api.upload('/api/import/preview', admin.token, form);
    assert.equal(preview.source, 'jamf');
    assert.ok(preview.rows.length >= 1);
  });
});

test('ManageEngine Dell Latitude row resolves via generic catalog modelMatch', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`MDM Resolve ${randomUUID().slice(0, 8)}`);
    const csv = await readFile(join(fixturesRoot, 'manageengine.csv'));
    const form = new FormData();
    form.set('source', 'auto');
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'manageengine.csv');
    const preview = await api.upload('/api/import/preview', admin.token, form);
    assert.equal(preview.source, 'manageengine');

    const dellRow = preview.rows.find((row) => /dell|latitude/i.test(`${row.manufacturer} ${row.modelName}`));
    assert.ok(dellRow, 'expected a Dell/Latitude row in manageengine fixture');
    assert.notEqual(dellRow.modelMatch, 'none', `expected catalog match, got ${dellRow.modelMatch}`);
    assert.ok(dellRow.modelId, 'expected resolved modelId');
  });
});

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-mdm-'));
  const port = 27_000 + Math.floor(Math.random() * 1_500);
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
    SAAS_JWT_SECRET: 'mdm-test-secret',
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
