import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saasDir = join(__dirname, '..');
const fixturePath = join(saasDir, '..', 'test', 'fixtures', 'intune-devices-sample.csv');
const jamfFixturePath = join(saasDir, '..', 'test', 'fixtures', 'jamf-macbooks-sample.csv');

test('two organizations stay isolated through CRUD, roles and CSV import', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-e2e-'));
  const port = 18_000 + Math.floor(Math.random() * 1_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: saasDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SAAS_DB_PATH: join(dir, 'saas.sqlite'),
      SAAS_JWT_SECRET: 'integration-test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });

  try {
    await waitForHealth(baseUrl);

    const orgA = await jsonRequest(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        orgName: 'Alpha Company',
        name: 'Alpha Admin',
        email: 'alpha@example.test',
        password: 'password-alpha'
      }
    });
    const orgB = await jsonRequest(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        orgName: 'Beta Company',
        name: 'Beta Admin',
        email: 'beta@example.test',
        password: 'password-beta'
      }
    });

    const alphaPerson = await jsonRequest(baseUrl, '/api/people', {
      method: 'POST',
      token: orgA.token,
      body: { firstName: 'Ana', lastName: 'Alpha', email: 'ana@alpha.test' }
    });

    const crossTenant = await rawJsonRequest(baseUrl, '/api/assets', {
      method: 'POST',
      token: orgB.token,
      body: {
        assetTag: 'CROSS',
        serialNumber: 'CROSS-SERIAL',
        personId: alphaPerson.id
      }
    });
    assert.equal(crossTenant.status, 400);

    await jsonRequest(baseUrl, '/api/assets', {
      method: 'POST',
      token: orgA.token,
      body: { assetTag: 'SHARED-TAG', serialNumber: 'SHARED-SERIAL', modelName: 'Alpha Laptop' }
    });
    await jsonRequest(baseUrl, '/api/assets', {
      method: 'POST',
      token: orgB.token,
      body: { assetTag: 'SHARED-TAG', serialNumber: 'SHARED-SERIAL', modelName: 'Beta Laptop' }
    });
    assert.equal((await jsonRequest(baseUrl, '/api/assets', { token: orgA.token })).length, 1);
    assert.equal((await jsonRequest(baseUrl, '/api/assets', { token: orgB.token })).length, 1);

    const readonlyInvite = await jsonRequest(baseUrl, '/api/invitations', {
      method: 'POST',
      token: orgA.token,
      body: { email: 'reader@example.test', role: 'readonly' }
    });
    const invitationToken = new URL(readonlyInvite.inviteUrl).searchParams.get('invite');
    const reader = await jsonRequest(baseUrl, '/api/invitations/accept', {
      method: 'POST',
      body: { token: invitationToken, name: 'Read Only', password: 'password-reader' }
    });
    const forbidden = await rawJsonRequest(baseUrl, '/api/people', {
      method: 'POST',
      token: reader.token,
      body: { firstName: 'No', lastName: 'Write' }
    });
    assert.equal(forbidden.status, 403);

    const multiOrgInvite = await jsonRequest(baseUrl, '/api/invitations', {
      method: 'POST',
      token: orgB.token,
      body: { email: 'alpha@example.test', role: 'it' }
    });
    await jsonRequest(baseUrl, '/api/invitations/accept', {
      method: 'POST',
      body: {
        token: new URL(multiOrgInvite.inviteUrl).searchParams.get('invite'),
        password: 'password-alpha'
      }
    });
    const organizationChoice = await jsonRequest(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'alpha@example.test', password: 'password-alpha' }
    });
    assert.equal(organizationChoice.requiresOrganization, true);
    assert.equal(organizationChoice.organizations.length, 2);
    const betaMembership = organizationChoice.organizations.find(
      (item) => item.id === orgB.organization.id
    );
    assert.equal(betaMembership.role, 'it');

    const csv = await readFile(fixturePath);
    const form = new FormData();
    form.set('source', 'intune');
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'intune.csv');
    const previewResponse = await fetch(`${baseUrl}/api/import/preview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${orgA.token}` },
      body: form
    });
    if (previewResponse.status !== 201) {
      assert.fail(`Preview failed: ${previewResponse.status} ${await previewResponse.text()}`);
    }
    const preview = await previewResponse.json();
    assert.equal(preview.source, 'intune');
    assert.ok(preview.rows.length > 0);

    const applied = await jsonRequest(baseUrl, '/api/import/apply', {
      method: 'POST',
      token: orgA.token,
      body: {
        batchId: preview.batchId,
        includeRowIds: preview.rows.filter((row) => row.action !== 'skip').map((row) => row.id)
      }
    });
    assert.equal(applied.ok, true);
    assert.ok(applied.summary.created + applied.summary.updated > 0);

    const alphaAssets = await jsonRequest(baseUrl, '/api/assets', { token: orgA.token });
    const betaAssets = await jsonRequest(baseUrl, '/api/assets', { token: orgB.token });
    assert.ok(alphaAssets.length > 1);
    assert.equal(betaAssets.length, 1);

    const jamfCsv = await readFile(jamfFixturePath);
    const jamfForm = new FormData();
    jamfForm.set('source', 'auto');
    jamfForm.set('file', new Blob([jamfCsv], { type: 'text/csv' }), 'jamf.csv');
    const jamfPreviewResponse = await fetch(`${baseUrl}/api/import/preview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${orgB.token}` },
      body: jamfForm
    });
    assert.equal(jamfPreviewResponse.status, 201);
    const jamfPreview = await jamfPreviewResponse.json();
    assert.equal(jamfPreview.source, 'jamf');
    await jsonRequest(baseUrl, '/api/import/apply', {
      method: 'POST',
      token: orgB.token,
      body: {
        batchId: jamfPreview.batchId,
        includeRowIds: jamfPreview.rows.filter((row) => row.action !== 'skip').map((row) => row.id)
      }
    });
    assert.ok((await jsonRequest(baseUrl, '/api/assets', { token: orgB.token })).length > 1);

    // A different customer may legitimately employ someone the original
    // single-company deployment excluded; SaaS must not silently drop them.
    const excludedNameCsv = [
      'Serial number,Device name,Manufacturer,Model,OS,Primary user UPN,Primary user display name',
      'SN-EXCLUDED-1,LAPTOP-1,Lenovo,ThinkPad X1,Windows,luminita.klein@beta.test,Luminita Klein'
    ].join('\r\n');
    const excludedForm = new FormData();
    excludedForm.set('source', 'intune');
    excludedForm.set('file', new Blob([excludedNameCsv], { type: 'text/csv' }), 'excluded.csv');
    const excludedPreviewResponse = await fetch(`${baseUrl}/api/import/preview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${orgB.token}` },
      body: excludedForm
    });
    assert.equal(excludedPreviewResponse.status, 201);
    const excludedPreview = await excludedPreviewResponse.json();
    assert.equal(excludedPreview.rows[0].person?.email, 'luminita.klein@beta.test');
    assert.equal(excludedPreview.rows[0].personMatch, 'new');

    const audit = await jsonRequest(baseUrl, '/api/audit', { token: orgA.token });
    assert.ok(audit.some((item) => item.action === 'import.apply'));
    assert.ok(audit.every((item) => !String(item.userEmail || '').includes('beta@')));
  } catch (error) {
    error.message += `\nServer output:\n${serverOutput}`;
    throw error;
  } finally {
    child.kill();
    await onceExited(child);
    await rm(dir, { recursive: true, force: true });
  }
});

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

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await rawJsonRequest(baseUrl, path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function rawJsonRequest(baseUrl, path, { method = 'GET', token = '', body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function onceExited(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}
