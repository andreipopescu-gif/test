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

test('GET /api/options returns status, department, and location', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Options Get ${randomUUID().slice(0, 8)}`);
    const options = await api.get('/api/options', admin.token);
    assert.ok(Array.isArray(options.status));
    assert.ok(Array.isArray(options.department));
    assert.ok(Array.isArray(options.location));
    assert.ok(options.status.some((item) => item.key === 'in_stock'));
  });
});

test('CRUD per kind: status with countsAs, department, location', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Options CRUD ${randomUUID().slice(0, 8)}`);

    const status = await api.post('/api/options/status', admin.token, {
      label: 'Ready shelf',
      meta: { countsAs: 'in_stock' }
    });
    assert.equal(status.label, 'Ready shelf');
    assert.equal(status.meta.countsAs, 'in_stock');
    assert.ok(status.key);

    const renamed = await api.patch(`/api/options/status/${status.id}`, admin.token, {
      label: 'Shelf ready',
      meta: { countsAs: 'in_stock' }
    });
    assert.equal(renamed.label, 'Shelf ready');
    assert.equal(renamed.meta.countsAs, 'in_stock');

    const department = await api.post('/api/options/department', admin.token, {
      label: 'Platform Engineering'
    });
    assert.equal(department.label, 'Platform Engineering');

    const location = await api.post('/api/options/location', admin.token, {
      label: 'Sofia Warehouse'
    });
    assert.equal(location.label, 'Sofia Warehouse');

    const all = await api.get('/api/options', admin.token);
    assert.ok(all.status.some((item) => item.id === status.id));
    assert.ok(all.department.some((item) => item.id === department.id));
    assert.ok(all.location.some((item) => item.id === location.id));

    const deletedDept = await api.delete(`/api/options/department/${department.id}`, admin.token);
    assert.equal(deletedDept.archived, true);
    const after = await api.get('/api/options', admin.token);
    assert.ok(!after.department.some((item) => item.id === department.id));
  });
});

test('option isolation: org A option is not visible to org B', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const alpha = await api.register(`Options Alpha ${randomUUID().slice(0, 8)}`);
    const beta = await api.register(`Options Beta ${randomUUID().slice(0, 8)}`);

    const created = await api.post('/api/options/location', alpha.token, {
      label: `Alpha Only ${randomUUID().slice(0, 6)}`
    });
    const alphaOptions = await api.get('/api/options', alpha.token);
    assert.ok(alphaOptions.location.some((item) => item.id === created.id));

    const betaOptions = await api.get('/api/options', beta.token);
    assert.ok(!betaOptions.location.some((item) => item.id === created.id));
    assert.ok(!betaOptions.location.some((item) => item.label === created.label));
  });
});

test('custom status with countsAs in_stock rolls into dashboard byStatus', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Options Dash ${randomUUID().slice(0, 8)}`);
    const status = await api.post('/api/options/status', admin.token, {
      label: 'Staging bay',
      meta: { countsAs: 'in_stock' }
    });
    const model = (await api.get('/api/catalog', admin.token)).models[0];
    await api.post('/api/assets', admin.token, {
      assetTag: `OPT-${randomUUID().slice(0, 6)}`,
      serialNumber: `OPT-SN-${randomUUID().slice(0, 8)}`,
      modelId: model.id,
      status: status.key
    });

    const dashboard = await api.get('/api/dashboard', admin.token);
    const inStock = dashboard.assets.byStatus.find((row) => row.label === 'in_stock');
    assert.ok(inStock, `expected in_stock bucket, got ${JSON.stringify(dashboard.assets.byStatus)}`);
    assert.ok(inStock.count >= 1);
    assert.ok(!dashboard.assets.byStatus.some((row) => row.label === status.key));
  });
});

test('asset create with unknown status returns 400', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Options Bad Status ${randomUUID().slice(0, 8)}`);
    const model = (await api.get('/api/catalog', admin.token)).models[0];
    const response = await api.raw('POST', '/api/assets', admin.token, {
      assetTag: 'BAD-1',
      serialNumber: 'BAD-SN-1',
      modelId: model.id,
      status: 'not_a_real_status'
    });
    assert.equal(response.status, 400);
  });
});

test('required custom fields reject missing values and accept valid ones', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Options Custom ${randomUUID().slice(0, 8)}`);
    const field = await api.post('/api/custom-fields', admin.token, {
      entity: 'asset',
      label: 'Cost center',
      key: 'cost_center',
      type: 'text',
      required: true
    });
    assert.equal(field.required, true);

    const model = (await api.get('/api/catalog', admin.token)).models[0];
    const missing = await api.raw('POST', '/api/assets', admin.token, {
      assetTag: 'CF-1',
      serialNumber: 'CF-SN-1',
      modelId: model.id
    });
    assert.equal(missing.status, 400);

    const created = await api.post('/api/assets', admin.token, {
      assetTag: 'CF-2',
      serialNumber: 'CF-SN-2',
      modelId: model.id,
      custom: { cost_center: 'IT-440' }
    });
    assert.equal(created.custom?.cost_center, 'IT-440');
  });
});

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-options-'));
  const port = 24_000 + Math.floor(Math.random() * 1_500);
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
    SAAS_JWT_SECRET: 'options-test-secret',
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
  return {
    raw,
    get: (path, token) => json('GET', path, token),
    post: (path, token, body) => json('POST', path, token, body),
    put: (path, token, body) => json('PUT', path, token, body),
    patch: (path, token, body) => json('PATCH', path, token, body),
    delete: (path, token) => json('DELETE', path, token),
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
