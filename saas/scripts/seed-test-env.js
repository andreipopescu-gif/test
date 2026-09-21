import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', '..', 'test', 'fixtures');
const baseUrl = String(process.env.TARGET_URL || 'http://localhost:3000').replace(/\/$/, '');
const suffix = process.env.SEED_SUFFIX
  || `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;

const plans = [
  { key: 'A', orgName: `Pilot Alpha ${suffix}`, source: 'intune', fixture: 'intune-devices-sample.csv' },
  { key: 'B', orgName: `Pilot Beta ${suffix}`, source: 'auto', fixture: 'jamf-macbooks-sample.csv' }
];

await waitForReady();

const orgs = [];
for (const plan of plans) {
  orgs.push(await seedOrganization(plan));
}

const checks = await verify(orgs[0], orgs[1]);
printSummary(orgs, checks);

if (checks.some((check) => !check.ok)) {
  console.error('\nVerification failed. See the checks marked FAIL above.');
  process.exit(1);
}

function newPassword() {
  return `Pilot!${randomBytes(12).toString('base64url')}`;
}

async function seedOrganization({ key, orgName, source, fixture }) {
  const lower = key.toLowerCase();
  // Passwords must not be derivable from the e-mail: seeded accounts stay live
  // on staging and the naming scheme is public in this repository.
  const accounts = {
    admin: { email: `admin-${lower}-${suffix}@pilot.test`, password: newPassword(), role: 'admin', name: `Pilot ${key} Admin` },
    it: { email: `it-${lower}-${suffix}@pilot.test`, password: newPassword(), role: 'it', name: `Pilot ${key} IT` },
    readonly: { email: `readonly-${lower}-${suffix}@pilot.test`, password: newPassword(), role: 'readonly', name: `Pilot ${key} Readonly` }
  };

  log(`Registering organization ${orgName}`);
  const registered = await api('POST', '/api/auth/register', {
    body: {
      orgName,
      email: accounts.admin.email,
      password: accounts.admin.password,
      name: accounts.admin.name,
      registrationToken: process.env.SEED_REGISTRATION_TOKEN || undefined
    }
  });
  accounts.admin.token = registered.token;

  for (const account of [accounts.it, accounts.readonly]) {
    log(`Inviting ${account.email} as ${account.role}`);
    const invitation = await api('POST', '/api/invitations', {
      token: accounts.admin.token,
      body: { email: account.email, role: account.role }
    });
    const accepted = await api('POST', '/api/invitations/accept', {
      body: {
        token: new URL(invitation.inviteUrl).searchParams.get('invite'),
        name: account.name,
        password: account.password
      }
    });
    account.token = accepted.token;
  }

  log(`Importing ${fixture} into ${orgName}`);
  const imported = await importCsv(accounts.admin.token, source, fixture);

  return {
    key,
    id: registered.organization.id,
    name: orgName,
    accounts,
    importSummary: imported.summary,
    people: await api('GET', '/api/people', { token: accounts.admin.token }),
    assets: await api('GET', '/api/assets', { token: accounts.admin.token })
  };
}

async function importCsv(token, source, fixture) {
  const preview = await previewCsv(token, source, fixture);
  return api('POST', '/api/import/apply', {
    token,
    body: {
      batchId: preview.batchId,
      includeRowIds: preview.rows.filter((row) => row.action !== 'skip').map((row) => row.id)
    }
  });
}

async function previewCsv(token, source, fixture) {
  const csv = await readFile(join(fixturesDir, fixture));
  const form = new FormData();
  form.set('source', source);
  form.set('file', new Blob([csv], { type: 'text/csv' }), fixture);
  const response = await fetch(`${baseUrl}/api/import/preview`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60_000)
  });
  const payload = await response.text();
  if (response.status !== 201) {
    fail(`POST /api/import/preview (${fixture}) returned ${response.status}: ${payload}`);
  }
  return JSON.parse(payload);
}

async function verify(orgA, orgB) {
  log('Verifying tenant isolation and role enforcement');
  const checks = [];

  const foreignPeople = await raw('GET', '/api/people', { token: orgB.accounts.admin.token });
  const foreignPeopleIds = new Set((await foreignPeople.json()).map((person) => person.id));
  checks.push({
    name: 'org B cannot see org A people',
    status: foreignPeople.status,
    ok: orgA.people.every((person) => !foreignPeopleIds.has(person.id))
  });

  const foreignAssets = await raw('GET', '/api/assets', { token: orgB.accounts.admin.token });
  const foreignAssetIds = new Set((await foreignAssets.json()).map((asset) => asset.id));
  checks.push({
    name: 'org B cannot see org A assets',
    status: foreignAssets.status,
    ok: orgA.assets.every((asset) => !foreignAssetIds.has(asset.id))
  });

  const crossDelete = await raw('DELETE', `/api/people/${orgA.people[0].id}`, {
    token: orgB.accounts.admin.token
  });
  checks.push({
    name: 'org B cannot delete an org A person',
    status: crossDelete.status,
    ok: crossDelete.status === 404
  });

  const readonlyPerson = await raw('POST', '/api/people', {
    token: orgA.accounts.readonly.token,
    body: { firstName: 'No', lastName: 'Write' }
  });
  checks.push({
    name: 'readonly cannot create a person',
    status: readonlyPerson.status,
    ok: readonlyPerson.status === 403
  });

  const itPreview = await previewCsv(orgA.accounts.it.token, 'intune', 'intune-devices-sample.csv');
  const readonlyApply = await raw('POST', '/api/import/apply', {
    token: orgA.accounts.readonly.token,
    body: { batchId: itPreview.batchId }
  });
  checks.push({
    name: 'readonly cannot apply an import',
    status: readonlyApply.status,
    ok: readonlyApply.status === 403
  });

  const itApply = await raw('POST', '/api/import/apply', {
    token: orgA.accounts.it.token,
    body: {
      batchId: itPreview.batchId,
      includeRowIds: itPreview.rows.filter((row) => row.action !== 'skip').map((row) => row.id)
    }
  });
  checks.push({
    name: 'it can apply an import',
    status: itApply.status,
    ok: itApply.ok
  });

  const readonlyPreview = await raw('POST', '/api/import/preview', {
    token: orgA.accounts.readonly.token
  });
  checks.push({
    name: 'readonly cannot preview an import',
    status: readonlyPreview.status,
    ok: readonlyPreview.status === 403
  });

  for (const [org, other] of [[orgA, orgB], [orgB, orgA]]) {
    const audit = await raw('GET', '/api/audit', { token: org.accounts.admin.token });
    const entries = await audit.json();
    const ownEmails = new Set(Object.values(org.accounts).map((account) => account.email));
    const otherEmails = new Set(Object.values(other.accounts).map((account) => account.email));
    checks.push({
      name: `org ${org.key} audit contains only its own actions (${entries.length} entries)`,
      status: audit.status,
      ok: entries.length > 0
        && entries.every((entry) => !entry.userEmail || ownEmails.has(entry.userEmail))
        && entries.every((entry) => !otherEmails.has(entry.userEmail))
    });
  }

  return checks;
}

function printSummary(seeded, checks) {
  console.log(`\n=== Seeded pilot environment ===`);
  console.log(`Target:  ${baseUrl}`);
  console.log(`Suffix:  ${suffix}`);
  for (const org of seeded) {
    console.log(`\nOrganization ${org.key}: ${org.name}`);
    console.log(`  id:      ${org.id}`);
    console.log(`  people:  ${org.people.length}`);
    console.log(`  assets:  ${org.assets.length}`);
    console.log(`  import:  created=${org.importSummary.created} updated=${org.importSummary.updated} peopleCreated=${org.importSummary.peopleCreated} skipped=${org.importSummary.skipped}`);
    console.log('  accounts:');
    for (const account of Object.values(org.accounts)) {
      console.log(`    ${account.role.padEnd(8)} ${account.email}  ${account.password}`);
    }
  }
  console.log('\n=== Verification ===');
  for (const check of checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  HTTP ${check.status}  ${check.name}`);
  }
}

async function waitForReady() {
  // Render free instances sleep; the first request after a cold start can take
  // close to a minute before the health check answers.
  const deadline = Date.now() + 120_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/ready`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        log(`Target ${baseUrl} is ready: ${await response.text()}`);
        return;
      }
    } catch {
      // Target is still starting.
    }
    if (Date.now() > deadline) fail(`${baseUrl}/api/ready did not become healthy`);
    log(`Waiting for ${baseUrl} to become ready (attempt ${attempt})`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function api(method, path, options = {}) {
  const response = await raw(method, path, options);
  const body = await response.text();
  if (!response.ok) fail(`${method} ${path} returned ${response.status}: ${body}`);
  return JSON.parse(body);
}

async function raw(method, path, { token = '', body } = {}) {
  try {
    return await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    fail(`${method} ${baseUrl}${path} could not be reached: ${error.cause?.message || error.message}`);
  }
}

function log(message) {
  console.log(`[seed] ${message}`);
}

function fail(message) {
  console.error(`\n[seed] FAILED: ${message}`);
  process.exit(1);
}
