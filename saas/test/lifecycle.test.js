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

test('a device can be reassigned and returned to stock', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Reassign Co');
    const ana = await api.post('/api/people', admin.token, {
      firstName: 'Ana', lastName: 'Popescu', email: 'ana@reassign.test'
    });
    const dan = await api.post('/api/people', admin.token, {
      firstName: 'Dan', lastName: 'Istrate', email: 'dan@reassign.test'
    });
    const laptop = await api.post('/api/assets', admin.token, {
      assetTag: 'LAP-1', serialNumber: 'SN-1', modelName: 'ThinkPad T14'
    });
    assert.equal(laptop.status, 'in_stock');

    const assigned = await api.put(`/api/assets/${laptop.id}`, admin.token, { personId: ana.id });
    assert.equal(assigned.personId, ana.id);
    assert.equal(assigned.status, 'assigned');

    const reassigned = await api.put(`/api/assets/${laptop.id}`, admin.token, { personId: dan.id });
    assert.equal(reassigned.personId, dan.id);
    assert.equal(reassigned.status, 'assigned');

    const returned = await api.put(`/api/assets/${laptop.id}`, admin.token, { personId: '' });
    assert.equal(returned.personId, null);
    assert.equal(returned.status, 'in_stock');

    const renamed = await api.put(`/api/assets/${laptop.id}`, admin.token, { modelName: 'ThinkPad X1' });
    assert.equal(renamed.modelName, 'ThinkPad X1');
    assert.equal(renamed.assetTag, 'LAP-1');

    const audit = await api.get('/api/audit', admin.token);
    assert.equal(audit.filter((entry) => entry.action === 'asset.assign').length, 3);
  });
});

test('a device cannot be assigned to another organization person', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const alpha = await api.register('Alpha Ltd');
    const beta = await api.register('Beta Ltd');
    const alphaPerson = await api.post('/api/people', alpha.token, {
      firstName: 'Ana', lastName: 'Alpha', email: 'ana@alpha.test'
    });
    const betaAsset = await api.post('/api/assets', beta.token, {
      assetTag: 'BETA-1', serialNumber: 'BETA-SN-1'
    });

    const response = await api.raw('PUT', `/api/assets/${betaAsset.id}`, beta.token, {
      personId: alphaPerson.id
    });
    assert.equal(response.status, 400);
  });
});

test('a person can be updated and deactivated', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('People Co');
    const person = await api.post('/api/people', admin.token, {
      firstName: 'Ana', lastName: 'Popescu', email: 'ana@people.test', department: 'IT'
    });

    const updated = await api.put(`/api/people/${person.id}`, admin.token, {
      lastName: 'Ionescu', status: 'inactive'
    });
    assert.equal(updated.lastName, 'Ionescu');
    assert.equal(updated.firstName, 'Ana');
    assert.equal(updated.department, 'IT');
    assert.equal(updated.status, 'inactive');
  });
});

test('changing a password ends the sessions that used the old one', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Rotate Co', 'password-original');
    assert.equal((await api.raw('GET', '/api/me', admin.token)).status, 200);

    const changed = await api.put('/api/me/password', admin.token, {
      currentPassword: 'password-original',
      newPassword: 'password-replacement'
    });
    assert.ok(changed.token);

    assert.equal((await api.raw('GET', '/api/me', admin.token)).status, 401);
    assert.equal((await api.raw('GET', '/api/me', changed.token)).status, 200);

    const relogin = await api.raw('POST', '/api/auth/login', '', {
      email: admin.email, password: 'password-replacement'
    });
    assert.equal(relogin.status, 200);
    const reissued = await relogin.json();
    assert.equal((await api.raw('GET', '/api/me', reissued.token)).status, 200);
  });
});

test('a wrong current password does not change anything', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Careful Co', 'password-careful');
    const rejected = await api.raw('PUT', '/api/me/password', admin.token, {
      currentPassword: 'not-the-password',
      newPassword: 'password-replacement'
    });
    assert.equal(rejected.status, 401);
    assert.equal((await api.raw('GET', '/api/me', admin.token)).status, 200);
  });
});

test('removing the last admin is refused, removing a member erases the account', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Members Co');
    const me = await api.get('/api/me', admin.token);

    const lastAdmin = await api.raw('DELETE', `/api/members/${me.user.id}`, admin.token);
    assert.equal(lastAdmin.status, 400);

    const invitation = await api.post('/api/invitations', admin.token, {
      email: 'guest@members.test', role: 'readonly'
    });
    const guest = await api.post('/api/invitations/accept', '', {
      token: inviteTokenFromUrl(invitation.inviteUrl),
      name: 'Guest',
      password: 'password-guest'
    });
    assert.equal((await api.get('/api/members', admin.token)).length, 2);

    const removed = await api.raw('DELETE', `/api/members/${guest.user.id}`, admin.token);
    assert.equal(removed.status, 200);
    assert.equal((await api.get('/api/members', admin.token)).length, 1);
    assert.equal((await api.raw('GET', '/api/me', guest.token)).status, 401);

    // The account belonged to no other organization, so the address is gone
    // and the same person can register again from scratch.
    const reRegister = await api.raw('POST', '/api/auth/register', '', {
      orgName: 'Guest Own Co', email: 'guest@members.test', password: 'password-guest-2'
    });
    assert.equal(reRegister.status, 201);
  });
});

test('deleting an organization needs its name and takes its data with it', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Disposable Co');
    await api.post('/api/people', admin.token, {
      firstName: 'Ana', lastName: 'Popescu', email: 'ana@disposable.test'
    });
    await api.post('/api/assets', admin.token, { assetTag: 'D-1', serialNumber: 'D-SN-1' });

    const wrongName = await api.raw('DELETE', '/api/organizations/current', admin.token, {
      confirm: 'Disposable'
    });
    assert.equal(wrongName.status, 400);
    assert.equal((await api.get('/api/people', admin.token)).length, 1);

    const response = await api.raw('DELETE', '/api/organizations/current', admin.token, {
      confirm: 'Disposable Co'
    });
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.deletedUsers, 1);
    assert.equal((await api.raw('GET', '/api/people', admin.token)).status, 401);
  });
});

test('a readonly member cannot update or delete', { timeout: 20_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Readonly Co');
    const person = await api.post('/api/people', admin.token, {
      firstName: 'Ana', lastName: 'Popescu', email: 'ana@readonly.test'
    });
    const asset = await api.post('/api/assets', admin.token, { assetTag: 'R-1', serialNumber: 'R-SN-1' });
    const invitation = await api.post('/api/invitations', admin.token, {
      email: 'viewer@readonly.test', role: 'readonly'
    });
    const viewer = await api.post('/api/invitations/accept', '', {
      token: inviteTokenFromUrl(invitation.inviteUrl),
      name: 'Viewer',
      password: 'password-viewer'
    });

    for (const [method, path] of [
      ['PUT', `/api/people/${person.id}`],
      ['PUT', `/api/assets/${asset.id}`],
      ['DELETE', `/api/members/${viewer.user.id}`],
      ['DELETE', '/api/organizations/current']
    ]) {
      const response = await api.raw(method, path, viewer.token, { confirm: 'Readonly Co' });
      assert.equal(response.status, 403, `${method} ${path} should be refused`);
    }
  });
});

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-lifecycle-'));
  const port = 20_000 + Math.floor(Math.random() * 1_500);
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
      SAAS_DB_PATH: join(dir, 'saas.sqlite'),
      SAAS_JWT_SECRET: 'lifecycle-test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const api = buildClient(baseUrl);
  try {
    await waitForHealth(baseUrl);
    await run(api);
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
    async register(orgName, password = 'password-admin') {
      const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
      const created = await json('POST', '/api/auth/register', '', { orgName, email, password });
      return { ...created, email, password };
    }
  };
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
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become healthy');
}
