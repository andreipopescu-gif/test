import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createIntuneStyleZip } from '../../src/import/zip-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saasDir = join(__dirname, '..');

test('the device catalog is seeded per organization on first access', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const alpha = await api.register('Catalog Alpha');
    const beta = await api.register('Catalog Beta');

    const catalog = await api.get('/api/catalog', alpha.token);
    assert.ok(catalog.categories.length > 0);
    assert.ok(catalog.brands.length > 0);
    assert.ok(catalog.models.some((model) => model.name.startsWith('ThinkPad')));
    // A second read must not duplicate the seed.
    assert.equal((await api.get('/api/catalog', alpha.token)).models.length, catalog.models.length);

    const created = await api.post('/api/catalog/models', alpha.token, {
      name: 'Framework 13',
      brand: 'Framework',
      category: 'Laptop',
      aliases: ['Framework Laptop 13']
    });
    assert.equal(created.name, 'Framework 13');
    assert.equal(created.categoryName, 'Laptop');

    const betaCatalog = await api.get('/api/catalog', beta.token);
    assert.ok(!betaCatalog.models.some((model) => model.name === 'Framework 13'));
    assert.ok(!betaCatalog.models.some((model) => model.id === created.id));

    const crossTenant = await api.raw('POST', '/api/assets', beta.token, {
      assetTag: 'X-1', serialNumber: 'X-SN-1', modelId: created.id
    });
    assert.equal(crossTenant.status, 400);
  });
});

test('assets carry rich hardware fields and expose their assignment history', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Detail Co');
    const ana = await api.post('/api/people', admin.token, {
      firstName: 'Ana', lastName: 'Pop', email: 'ana@detail.test',
      externalIds: { upn: 'ana.pop@detail.test', alternateEmails: ['a.pop@detail.test'] }
    });
    assert.equal((await api.get('/api/people', admin.token))[0].externalIds.upn, 'ana.pop@detail.test');

    const model = (await api.get('/api/catalog', admin.token)).models[0];
    const laptop = await api.post('/api/assets', admin.token, {
      assetTag: 'D-1',
      serialNumber: 'D-SN-1',
      modelId: model.id,
      category: 'Laptop',
      brand: 'Lenovo',
      ramGb: 16,
      storageGb: 512,
      cpu: 'Ultra 7',
      operatingSystem: 'Windows 11',
      warrantyEndsOn: '2031-01-01',
      purchasedOn: '2028-01-01',
      vendor: 'Reseller',
      notes: 'Spare charger included',
      externalIds: { intuneDeviceId: 'intune-1' },
      personId: ana.id
    });
    assert.equal(laptop.ramGb, 16);
    assert.equal(laptop.operatingSystem, 'Windows 11');
    assert.equal(laptop.externalIds.intuneDeviceId, 'intune-1');

    await api.put(`/api/assets/${laptop.id}`, admin.token, { personId: '' });
    const detail = await api.get(`/api/assets/${laptop.id}`, admin.token);
    assert.equal(detail.serialNumber, 'D-SN-1');
    assert.equal(detail.model.name, model.name);
    assert.equal(detail.person, null);
    assert.equal(detail.assignments.length, 1);
    assert.equal(detail.assignments[0].person.email, 'ana@detail.test');
    assert.ok(detail.assignments[0].endedAt);
    assert.equal(detail.currentAssignment, null);
    // Rich fields survive a partial update that only touches the owner.
    assert.equal(detail.cpu, 'Ultra 7');
    assert.equal(detail.vendor, 'Reseller');

    const missing = await api.raw('GET', `/api/assets/${randomUUID()}`, admin.token);
    assert.equal(missing.status, 404);
  });
});

test('merging two people keeps one record with the devices and every address', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Merge Co');
    const keep = await api.post('/api/people', admin.token, {
      firstName: 'Ioana', lastName: 'Marin', email: 'ioana.marin@merge.test',
      department: 'IT'
    });
    const absorb = await api.post('/api/people', admin.token, {
      firstName: 'Ioana', lastName: 'Marin', email: 'i.marin@merge.test',
      externalIds: { jamfUsername: 'imarin', entraObjectId: 'obj-1' }
    });
    const laptop = await api.post('/api/assets', admin.token, {
      assetTag: 'M-1', serialNumber: 'M-SN-1', personId: absorb.id
    });

    const merged = await api.post('/api/people/merge', admin.token, {
      keepId: keep.id, absorbId: absorb.id
    });
    assert.equal(merged.movedAssets, 1);
    assert.equal(merged.person.id, keep.id);
    assert.ok(merged.person.externalIds.alternateEmails.includes('i.marin@merge.test'));
    assert.equal(merged.person.externalIds.jamfUsername, 'imarin');

    const people = await api.get('/api/people', admin.token);
    assert.equal(people.length, 1);
    const detail = await api.get(`/api/assets/${laptop.id}`, admin.token);
    assert.equal(detail.person.id, keep.id);
    assert.equal(detail.assignments[0].personId, keep.id);

    const sameId = await api.raw('POST', '/api/people/merge', admin.token, {
      keepId: keep.id, absorbId: keep.id
    });
    assert.equal(sameId.status, 400);
  });
});

test('the dashboard counts only the calling organization', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const alpha = await api.register('Dashboard Alpha');
    const beta = await api.register('Dashboard Beta');
    const person = await api.post('/api/people', alpha.token, {
      firstName: 'Radu', lastName: 'Ene', email: 'radu@dash.test', department: 'Finance'
    });
    await api.post('/api/assets', alpha.token, {
      assetTag: 'DB-1', serialNumber: 'DB-SN-1', personId: person.id, category: 'Laptop'
    });
    await api.post('/api/assets', alpha.token, {
      assetTag: 'DB-2', serialNumber: 'DB-SN-2', warrantyEndsOn: inDays(10)
    });
    await api.post('/api/assets', beta.token, { assetTag: 'B-1', serialNumber: 'B-SN-1' });

    const dashboard = await api.get('/api/dashboard', alpha.token);
    assert.equal(dashboard.counts.assets, 2);
    assert.equal(dashboard.counts.assignedAssets, 1);
    assert.equal(dashboard.counts.peopleWithoutDevice, 0);
    assert.equal(dashboard.warranty.expiring30, 1);
    assert.equal(dashboard.warranty.expiring90, 1);
    assert.deepEqual(
      dashboard.assets.byStatus.find((item) => item.label === 'assigned'),
      { label: 'assigned', count: 1 }
    );
    assert.deepEqual(
      dashboard.people.byDepartment,
      [{ label: 'Finance', count: 1 }]
    );
    assert.equal(dashboard.recentAssignments.length, 1);
    assert.equal(dashboard.recentAssignments[0].personName, 'Radu Ene');
    assert.equal(dashboard.recentAssignments[0].assetTag, 'DB-1');

    assert.equal((await api.get('/api/dashboard', beta.token)).counts.assets, 1);
  });
});

test('exports and reports return CSV for the calling organization', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Report Co');
    const person = await api.post('/api/people', admin.token, {
      firstName: 'Vlad', lastName: 'Toma', email: 'vlad@report.test', department: 'Sales'
    });
    await api.post('/api/people', admin.token, {
      firstName: 'Fara', lastName: 'Device', email: 'fara@report.test'
    });
    await api.post('/api/assets', admin.token, {
      assetTag: 'R-1', serialNumber: 'R-SN-1', personId: person.id, modelName: 'ThinkPad T14'
    });
    await api.post('/api/assets', admin.token, {
      assetTag: 'R-2', serialNumber: 'R-SN-2', warrantyEndsOn: inDays(45)
    });

    const types = await api.get('/api/reports', admin.token);
    assert.ok(types.some((type) => type.id === 'in_stock'));

    const exported = await api.text('/api/export/assets', admin.token);
    assert.equal(exported.contentType, 'text/csv; charset=utf-8');
    assert.ok(exported.body.includes('R-SN-1'));
    assert.ok(exported.body.includes('Vlad Toma'));

    const inStock = await api.text('/api/reports/in_stock', admin.token);
    assert.ok(inStock.body.includes('R-2'));
    assert.ok(!inStock.body.includes('R-1'));

    const byDepartment = await api.text('/api/reports/assigned_by_department', admin.token);
    assert.ok(byDepartment.body.includes('Sales'));

    const warranty90 = await api.text('/api/reports/warranty_90', admin.token);
    assert.ok(warranty90.body.includes('R-2'));
    assert.ok(!(await api.text('/api/reports/warranty_30', admin.token)).body.includes('R-2'));

    const withoutDevice = await api.text('/api/reports/people_without_device', admin.token);
    assert.ok(withoutDevice.body.includes('fara@report.test'));
    assert.ok(!withoutDevice.body.includes('vlad@report.test'));

    assert.equal((await api.raw('GET', '/api/reports/nope', admin.token)).status, 404);
  });
});

test('an Intune import keeps hardware detail and flags devices that stopped reporting', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Import Co');
    const header = 'Device ID,Device name,Serial number,Primary user UPN,Primary user display name,Manufacturer,Model,OS,OS version,IMEI,Total storage,Enrollment date';
    const first = [
      header,
      'd1,PC-1,SN-IMP-1,ana@import.test,Ana Pop,Lenovo,ThinkPad T14,Windows,11,,512000000000,2026-01-02',
      'd2,PC-2,SN-IMP-2,dan@import.test,Dan Ene,Lenovo,ThinkPad X1,Windows,11,,512000000000,2026-01-02'
    ].join('\n');

    const preview = await api.preview(admin.token, first);
    assert.equal(preview.summary.create, 2);
    assert.equal(preview.rows[0].operatingSystem, 'Windows 11');
    await api.apply(admin.token, preview);

    const assets = await api.get('/api/assets', admin.token);
    const first1 = assets.find((asset) => asset.serialNumber === 'SN-IMP-1');
    assert.equal(first1.operatingSystem, 'Windows 11');
    assert.equal(first1.storageGb, 477);
    assert.equal(first1.enrolledAt, '2026-01-02');
    assert.equal(first1.importMeta.source, 'intune');
    assert.equal(first1.importMeta.missingFromLastImport, false);

    // The second export drops PC-2 and hands PC-1 to someone else.
    const second = [
      header,
      'd1,PC-1,SN-IMP-1,dan@import.test,Dan Ene,Lenovo,ThinkPad T14,Windows,11,,512000000000,2026-01-02'
    ].join('\n');
    const reassignPreview = await api.preview(admin.token, second);
    assert.equal(reassignPreview.rows[0].action, 'reassign');
    assert.equal(reassignPreview.summary.reassign, 1);
    const applied = await api.apply(admin.token, reassignPreview);
    assert.equal(applied.summary.missingFromImport, 1);

    const afterAssets = await api.get('/api/assets', admin.token);
    const kept = afterAssets.find((asset) => asset.serialNumber === 'SN-IMP-1');
    const dropped = afterAssets.find((asset) => asset.serialNumber === 'SN-IMP-2');
    assert.equal(kept.importMeta.missingFromLastImport, false);
    assert.equal(dropped.importMeta.missingFromLastImport, true);
    assert.ok(dropped.importMeta.missingDetectedAt);

    const detail = await api.get(`/api/assets/${kept.id}`, admin.token);
    assert.equal(detail.assignments.length, 2);
    assert.equal(detail.currentAssignment.person.email, 'dan@import.test');

    const missingReport = await api.text('/api/reports/missing_from_mdm', admin.token);
    assert.ok(missingReport.body.includes('SN-IMP-2'));
  });
});

test('an Intune ZIP export is accepted like a plain CSV', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Zip Co');
    const csv = [
      'Device ID,Device name,Serial number,Primary user UPN,Primary user display name,Manufacturer,Model,OS',
      'z1,PC-Z,SN-ZIP-1,ana@zip.test,Ana Zip,Lenovo,ThinkPad T14,Windows'
    ].join('\n');
    const zip = createIntuneStyleZip('devices.csv', csv);

    const form = new FormData();
    form.set('source', 'intune');
    form.set('file', new Blob([zip], { type: 'application/zip' }), 'export.zip');
    const preview = await api.upload('/api/import/preview', admin.token, form);
    assert.equal(preview.source, 'intune');
    assert.equal(preview.rows.length, 1);
    assert.equal(preview.rows[0].serialNumber, 'SN-ZIP-1');
  });
});

test('user CSV import creates and updates people in the calling organization', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Users Co');
    await api.put('/api/settings', admin.token, { excludedEmails: ['shared.mailbox@users.test'] });
    const csv = [
      'User principal name,Display name,First name,Last name,Mail,Department,Job title,Account enabled,Object Id',
      'ana@users.test,Ana Ionescu,Ana,Ionescu,ana@users.test,IT,Engineer,Yes,obj-ana',
      'shared.mailbox@users.test,Shared Mailbox,Shared,Mailbox,shared.mailbox@users.test,IT,,Yes,obj-shared'
    ].join('\n');

    const form = new FormData();
    form.set('source', 'entra');
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'users.csv');
    const preview = await api.upload('/api/import/users/preview', admin.token, form);
    assert.equal(preview.kind, 'users');
    assert.equal(preview.source, 'entra');
    assert.equal(preview.summary.create, 1);
    assert.equal(preview.summary.skip, 1);

    const applied = await api.post('/api/import/users/apply', admin.token, {
      batchId: preview.batchId,
      includeRowIds: preview.rows.filter((row) => row.action !== 'skip').map((row) => row.id)
    });
    assert.equal(applied.summary.created, 1);

    const people = await api.get('/api/people', admin.token);
    assert.equal(people.length, 1);
    assert.equal(people[0].email, 'ana@users.test');
    assert.equal(people[0].department, 'IT');
    assert.equal(people[0].externalIds.entraObjectId, 'obj-ana');
  });
});

test('organization settings round-trip every rule type', { timeout: 30_000 }, async () => {
  await withServer(async (api) => {
    const admin = await api.register('Settings Round Trip');
    const payload = {
      excludedEmails: ['Noreply@Round.test'],
      excludedNameRules: [{ id: 'vendor', tokens: ['Acme', 'Support'] }],
      identityGroups: [{
        emails: ['old.name@round.test', 'new.name@round.test'],
        firstName: 'Maria',
        lastName: 'Noua'
      }],
      modelOverrides: { 'sn-1': 'model-1' }
    };
    const saved = await api.put('/api/settings', admin.token, payload);
    assert.deepEqual(saved.excludedEmails, ['noreply@round.test']);
    assert.deepEqual(saved.excludedNameRules, [{ id: 'vendor', tokens: ['acme', 'support'] }]);
    assert.deepEqual(saved.identityGroups[0].emails, ['old.name@round.test', 'new.name@round.test']);
    assert.deepEqual(saved.modelOverrides, { 'sn-1': 'model-1' });
    assert.deepEqual(await api.get('/api/settings', admin.token), saved);
  });
});

function inDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function withServer(run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-parity-'));
  const port = 23_000 + Math.floor(Math.random() * 1_500);
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
    SAAS_JWT_SECRET: 'parity-test-secret',
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
    put: (path, token, body) => json('PUT', path, token, body),
    async text(path, token) {
      const response = await raw('GET', path, token);
      if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
      return {
        contentType: response.headers.get('content-type'),
        body: await response.text()
      };
    },
    async register(orgName) {
      const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
      const created = await json('POST', '/api/auth/register', '', {
        orgName, email, password: 'password-admin'
      });
      return { ...created, email };
    },
    preview(token, csv) {
      const form = new FormData();
      form.set('source', 'intune');
      form.set('file', new Blob([csv], { type: 'text/csv' }), 'devices.csv');
      return upload('/api/import/preview', token, form);
    },
    apply(token, preview) {
      return json('POST', '/api/import/apply', token, {
        batchId: preview.batchId,
        includeRowIds: preview.rows.filter((row) => row.action !== 'skip').map((row) => row.id)
      });
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
