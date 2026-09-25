import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  annotateImportOverage,
  assertWithinPlan,
  normalizeBillingRow,
  paymentRequired,
  suspendedBlocksMutation
} from '../src/plans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saasDir = join(__dirname, '..');

test('expired trial normalizes to past_due, not suspended', () => {
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const billing = normalizeBillingRow({
    plan: 'trial',
    status: 'trial',
    device_limit: 50,
    trial_ends_at: past
  });
  assert.equal(billing.status, 'past_due');
  assert.equal(billing.plan, 'trial');
});

test('assertWithinPlan returns 402 with usage details', () => {
  assert.throws(
    () => assertWithinPlan({ plan: 'starter', status: 'active', deviceLimit: 2 }, 2, { adding: 1 }),
    (error) => error.status === 402
      && error.details.deviceUsage === 2
      && error.details.deviceLimit === 2
      && error.details.overage === 1
  );
});

test('import overage is annotated without throwing', () => {
  const summary = annotateImportOverage(
    { create: 3, update: 1, skip: 0, warnings: 0 },
    { plan: 'trial', planLabel: 'Trial', deviceLimit: 2, status: 'trial' },
    1
  );
  assert.equal(summary.deviceOverage, 2);
  assert.match(summary.billingWarning, /exceed/i);
});

test('suspended blocks mutations but not GET', () => {
  assert.equal(suspendedBlocksMutation('GET'), false);
  assert.equal(suspendedBlocksMutation('POST'), true);
  assert.equal(paymentRequired('x').status, 402);
});

test('device limit blocks create but still lists and exports', { timeout: 30_000 }, async () => {
  await withServer(async (api, { dbPath }) => {
    const admin = await api.register('Limit Co');
    await setOrgPlan(dbPath, admin.organization.id, {
      plan: 'starter',
      status: 'active',
      device_limit: 1
    });

    const first = await api.post('/api/assets', admin.token, {
      assetTag: 'LIM-1', serialNumber: 'LIM-SN-1', modelName: 'Frame'
    });
    assert.ok(first.id);

    const blocked = await api.raw('POST', '/api/assets', admin.token, {
      assetTag: 'LIM-2', serialNumber: 'LIM-SN-2', modelName: 'Frame'
    });
    assert.equal(blocked.status, 402);
    const body = await blocked.json();
    assert.equal(body.details.deviceLimit, 1);
    assert.equal(body.details.deviceUsage, 1);

    const listed = await api.get('/api/assets', admin.token);
    assert.equal(listed.length, 1);

    const exported = await api.raw('GET', '/api/export/assets', admin.token);
    assert.equal(exported.status, 200);
    const csv = await exported.text();
    assert.match(csv, /LIM-1/);
  });
});

test('import overage is reported in preview and still applies', { timeout: 45_000 }, async () => {
  await withServer(async (api, { dbPath }) => {
    const admin = await api.register('Import Overage Co');
    await setOrgPlan(dbPath, admin.organization.id, {
      plan: 'starter',
      status: 'active',
      device_limit: 1
    });

    const csv = [
      'Device ID,Device name,Serial number,Primary user UPN,Primary user display name,Last check-in,Manufacturer,Model,OS',
      'd1,PC-1,SN-OVER-1,a@example.test,Ana,2026-09-01,Lenovo,ThinkPad,Windows',
      'd2,PC-2,SN-OVER-2,b@example.test,Dan,2026-09-01,Lenovo,ThinkPad,Windows'
    ].join('\n');

    const form = new FormData();
    form.append('source', 'intune');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'devices.csv');
    const preview = await api.upload('/api/import/preview', admin.token, form);
    assert.equal(preview.summary.create, 2);
    assert.ok(preview.summary.deviceOverage >= 1);
    assert.match(preview.summary.billingWarning || '', /overage|exceed/i);

    const applied = await api.post('/api/import/apply', admin.token, {
      batchId: preview.batchId,
      includeRowIds: preview.rows.filter((row) => row.action === 'create').map((row) => row.id)
    });
    assert.ok(applied.summary.created >= 2);
    const assets = await api.get('/api/assets', admin.token);
    assert.ok(assets.length >= 2);
  });
});

test('suspended org blocks mutations and allows GET plus export', { timeout: 30_000 }, async () => {
  await withServer(async (api, { dbPath }) => {
    const admin = await api.register('Suspended Co');
    await api.post('/api/assets', admin.token, {
      assetTag: 'SUS-1', serialNumber: 'SUS-SN-1', modelName: 'Frame'
    });
    await setOrgPlan(dbPath, admin.organization.id, {
      plan: 'starter',
      status: 'suspended',
      device_limit: 100
    });

    assert.equal((await api.raw('GET', '/api/assets', admin.token)).status, 200);
    assert.equal((await api.raw('GET', '/api/billing', admin.token)).status, 200);
    assert.equal((await api.raw('GET', '/api/export/assets', admin.token)).status, 200);

    const create = await api.raw('POST', '/api/assets', admin.token, {
      assetTag: 'SUS-2', serialNumber: 'SUS-SN-2', modelName: 'Frame'
    });
    assert.equal(create.status, 402);

    const person = await api.raw('POST', '/api/people', admin.token, {
      firstName: 'Ana', lastName: 'Suspended', email: 'ana@suspended.test'
    });
    assert.equal(person.status, 402);
  });
});

test('device limits are isolated per organization', { timeout: 30_000 }, async () => {
  await withServer(async (api, { dbPath }) => {
    const alpha = await api.register('Alpha Limit');
    const beta = await api.register('Beta Limit');
    await setOrgPlan(dbPath, alpha.organization.id, {
      plan: 'starter', status: 'active', device_limit: 1
    });
    await setOrgPlan(dbPath, beta.organization.id, {
      plan: 'starter', status: 'active', device_limit: 1
    });

    await api.post('/api/assets', alpha.token, {
      assetTag: 'A-1', serialNumber: 'A-SN-1', modelName: 'Frame'
    });
    const alphaBlocked = await api.raw('POST', '/api/assets', alpha.token, {
      assetTag: 'A-2', serialNumber: 'A-SN-2', modelName: 'Frame'
    });
    assert.equal(alphaBlocked.status, 402);

    const betaOk = await api.post('/api/assets', beta.token, {
      assetTag: 'B-1', serialNumber: 'B-SN-1', modelName: 'Frame'
    });
    assert.ok(betaOk.id);
  });
});

test('GET /api/plans is public and GET /api/billing returns usage', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const plans = await api.get('/api/plans');
    assert.ok(Array.isArray(plans.plans));
    assert.ok(plans.plans.some((plan) => plan.key === 'starter'));

    const admin = await api.register('Billing Me Co');
    const billing = await api.get('/api/billing', admin.token);
    assert.equal(billing.plan, 'trial');
    assert.equal(billing.status, 'trial');
    assert.equal(billing.deviceLimit, 50);
    assert.ok(billing.trialEndsAt);
    assert.equal(billing.deviceUsage, 0);
    assert.equal(billing.metric, 'managed_devices');
  });
});

async function setOrgPlan(dbPath, organizationId, fields) {
  const { openDatabase } = await import('../src/db.js');
  const db = await openDatabase({ dbPath, databaseUrl: '' });
  try {
    await db.run(`
      UPDATE organizations
      SET plan = ?, status = ?, device_limit = ?
      WHERE id = ?
    `, [fields.plan, fields.status, fields.device_limit, organizationId]);
  } finally {
    await db.close();
  }
}

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-billing-'));
  const dbPath = join(dir, 'saas.sqlite');
  const port = 21_000 + Math.floor(Math.random() * 1_500);
  const baseUrl = `http://127.0.0.1:${port}`;
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
      SAAS_JWT_SECRET: 'billing-test-secret-at-least-32-chars!!'
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
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  };

  return {
    raw,
    get: (path, token) => {
      if (!token && path === '/api/plans') return json('GET', path, '');
      return json('GET', path, token);
    },
    post: (path, token, body) => json('POST', path, token, body),
    async upload(path, token, form) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(`UPLOAD ${path}: ${response.status} ${JSON.stringify(payload)}`);
      return payload;
    },
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
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become healthy');
}
