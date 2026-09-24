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

test('rename category, brand, and model via PATCH', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Catalog Rename ${randomUUID().slice(0, 8)}`);
    const catalog = await api.get('/api/catalog', admin.token);
    const category = catalog.categories[0];
    const brand = catalog.brands.find((item) => item.categoryId === category.id) || catalog.brands[0];
    const model = catalog.models.find((item) => item.brandId === brand.id) || catalog.models[0];

    const renamedCategory = await api.patch(`/api/catalog/categories/${category.id}`, admin.token, {
      name: `Renamed Cat ${randomUUID().slice(0, 6)}`
    });
    assert.equal(renamedCategory.name.startsWith('Renamed Cat'), true);

    const renamedBrand = await api.patch(`/api/catalog/brands/${brand.id}`, admin.token, {
      name: `Renamed Brand ${randomUUID().slice(0, 6)}`
    });
    assert.equal(renamedBrand.name.startsWith('Renamed Brand'), true);

    const renamedModel = await api.patch(`/api/catalog/models/${model.id}`, admin.token, {
      name: `Renamed Model ${randomUUID().slice(0, 6)}`
    });
    assert.equal(renamedModel.name.startsWith('Renamed Model'), true);
  });
});

test('DELETE archives model when assets reference it and hard-deletes when unused', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Catalog Delete ${randomUUID().slice(0, 8)}`);
    const catalog = await api.get('/api/catalog', admin.token);
    const used = catalog.models[0];
    const unused = catalog.models[1] || (await api.post('/api/catalog/models', admin.token, {
      name: `Temp Unused ${randomUUID().slice(0, 6)}`,
      brand: 'Lenovo',
      category: 'Laptop'
    }));

    await api.post('/api/assets', admin.token, {
      assetTag: `CAT-${randomUUID().slice(0, 6)}`,
      serialNumber: `CAT-SN-${randomUUID().slice(0, 8)}`,
      modelId: used.id
    });

    const archived = await api.delete(`/api/catalog/models/${used.id}`, admin.token);
    assert.equal(archived.archived, true);

    const hard = await api.delete(`/api/catalog/models/${unused.id}`, admin.token);
    assert.equal(hard.deleted, true);

    const after = await api.get('/api/catalog', admin.token);
    assert.ok(!after.models.some((item) => item.id === used.id));
    assert.ok(!after.models.some((item) => item.id === unused.id));
  });
});

test('POST /api/catalog/reset-defaults is idempotent and restores deleted seed models', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Catalog Reset ${randomUUID().slice(0, 8)}`);
    const before = await api.get('/api/catalog', admin.token);
    const seedModel = before.models.find((model) => /ThinkPad|Latitude|EliteBook|MacBook/i.test(model.name));
    assert.ok(seedModel, 'expected a recognizable seed model');

    const removed = await api.delete(`/api/catalog/models/${seedModel.id}`, admin.token);
    assert.equal(removed.deleted, true);
    assert.ok(!(await api.get('/api/catalog', admin.token)).models.some((item) => item.id === seedModel.id));

    const first = await api.post('/api/catalog/reset-defaults', admin.token, {});
    assert.ok(first.added.models >= 1);
    const restored = await api.get('/api/catalog', admin.token);
    assert.ok(restored.models.some((item) => item.name === seedModel.name));

    const second = await api.post('/api/catalog/reset-defaults', admin.token, {});
    assert.equal(second.added.models, 0);
    assert.equal((await api.get('/api/catalog', admin.token)).models.length, restored.models.length);
  });
});

test('seed catalog has no MTR RO or MTR BG categories', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Catalog Seed ${randomUUID().slice(0, 8)}`);
    const catalog = await api.get('/api/catalog', admin.token);
    assert.ok(!catalog.categories.some((item) => item.name === 'MTR RO' || item.name === 'MTR BG'));
  });
});

test('IT role can create models but not categories', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register(`Catalog Roles ${randomUUID().slice(0, 8)}`);
    const inviteEmail = `it-${randomUUID().slice(0, 8)}@example.test`;
    const invitation = await api.post('/api/invitations', admin.token, {
      email: inviteEmail,
      role: 'it'
    });
    const inviteToken = new URL(invitation.inviteUrl).searchParams.get('invite');
    assert.ok(inviteToken);

    const accepted = await api.post('/api/invitations/accept', '', {
      token: inviteToken,
      password: 'password-it-user',
      name: 'IT User'
    });
    assert.equal(accepted.role, 'it');

    const categoryDenied = await api.raw('POST', '/api/catalog/categories', accepted.token, {
      name: `IT Category ${randomUUID().slice(0, 6)}`
    });
    assert.equal(categoryDenied.status, 403);

    const model = await api.post('/api/catalog/models', accepted.token, {
      name: `IT Model ${randomUUID().slice(0, 6)}`,
      brand: 'Lenovo',
      category: 'Laptop'
    });
    assert.ok(model.id);
    assert.equal(model.name.startsWith('IT Model'), true);
  });
});

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-catalog-'));
  const port = 25_500 + Math.floor(Math.random() * 1_500);
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
    SAAS_JWT_SECRET: 'catalog-test-secret',
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
