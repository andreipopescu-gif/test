const baseUrl = String(process.env.TARGET_URL || 'http://localhost:3000').replace(/\/$/, '');
const email = String(process.env.RESET_EMAIL || '');
const password = String(process.env.RESET_PASSWORD || '');
const organizationId = String(process.env.RESET_ORG_ID || '');

if (!email || !password) {
  console.error('Usage: TARGET_URL=https://host RESET_EMAIL=admin@pilot.test RESET_PASSWORD=... [RESET_ORG_ID=...] npm run reset:test');
  process.exit(1);
}

const session = await login();
console.log(`[reset] Organization ${session.organization.name} (${session.organization.id}) as ${session.role}`);

const assets = await api('GET', '/api/assets', { token: session.token });
for (const asset of assets) {
  await api('DELETE', `/api/assets/${asset.id}`, { token: session.token });
}
console.log(`[reset] Deleted ${assets.length} assets`);

const people = await api('GET', '/api/people', { token: session.token });
for (const person of people) {
  await api('DELETE', `/api/people/${person.id}`, { token: session.token });
}
console.log(`[reset] Deleted ${people.length} people`);

console.log([
  '',
  '[reset] Partial teardown only. The current API exposes no delete route for',
  '[reset] organizations, users, memberships, invitations, import batches/rows or',
  '[reset] audit logs, so those rows stay behind. To remove an organization',
  '[reset] completely, run this against the target database:',
  '',
  `  DELETE FROM organizations WHERE id = '${session.organization.id}';`,
  '',
  '[reset] Every tenant table references organizations(id), so that single',
  '[reset] statement cascades. Users with no remaining membership can then be',
  '[reset] removed with:',
  '',
  '  DELETE FROM users u WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id);',
  ''
].join('\n'));

async function login() {
  const attempt = await api('POST', '/api/auth/login', {
    body: { email, password, ...(organizationId ? { organizationId } : {}) }
  });
  if (!attempt.requiresOrganization) return attempt;
  const names = attempt.organizations.map((org) => `${org.name} (${org.id})`).join(', ');
  fail(`${email} belongs to several organizations. Set RESET_ORG_ID to one of: ${names}`);
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

function fail(message) {
  console.error(`\n[reset] FAILED: ${message}`);
  process.exit(1);
}
