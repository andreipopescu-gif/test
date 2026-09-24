// Fills one organization with the demo Entra + Jamf data and walks it through
// the two changes a CSV snapshot cannot show on its own (a manual handover and
// a Mac that disappears from Jamf), so every exception rule has an example.
//
//   TARGET_URL=https://… DEMO_EMAIL=… DEMO_PASSWORD=… npm run seed:demo
//   TARGET_URL=http://localhost:8090 SEED_REGISTRATION_TOKEN=… npm run seed:demo
//
// Without DEMO_EMAIL a new organization is registered. Run it only against
// sample organizations: the second sync marks every other Jamf device in the
// organization as missing from the last export, exactly like a real partial
// export would.

import { randomBytes } from 'node:crypto';

const baseUrl = String(process.env.TARGET_URL || 'http://localhost:8090').replace(/\/$/, '');
const EXPECTED = [
  'user_active_no_device',
  'device_no_owner',
  'disabled_user_has_device',
  'device_stale_checkin',
  'device_missing_from_mdm',
  'owner_mismatch',
  'duplicate_device'
];

const session = await signIn();
const token = session.token;
console.log(`Organization: ${session.organization.name}`);

await call('PUT', '/api/connections/mock', { config: {} });
const first = await call('POST', '/api/connections/mock/sync', {});
console.log(`First sync: ${first.users?.created ?? 0} users, ${first.devices?.created ?? 0} devices created`);

await call('PUT', '/api/connections/mock', { config: { dropSerials: ['C02MOCK005'] } });
await call('POST', '/api/connections/mock/sync', {});
console.log('Second sync without C02MOCK005 (it left Jamf)');

// A sync re-applies the owner Jamf reports, so the handover happens last.
const people = await call('GET', '/api/people');
const assets = await call('GET', '/api/assets');
const dan = people.find((person) => person.email === 'dan.ionescu@demo.example');
const anaMac = assets.find((asset) => asset.serialNumber === 'C02MOCK001');
if (dan && anaMac && anaMac.personId !== dan.id) {
  await call('PUT', `/api/assets/${anaMac.id}`, { personId: dan.id });
  console.log('Handed Ana\u2019s MacBook to Dan by hand (Jamf still reports Ana)');
}

const summary = await call('GET', '/api/exceptions/summary');
for (const item of summary.byRule) console.log(`  ${String(item.count).padStart(3)}  ${item.label}`);
const missing = EXPECTED.filter((key) => !summary.byRule.some((item) => item.ruleKey === key && item.count > 0));
if (missing.length) {
  console.error(`Rules without an example: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`${summary.open} open issue(s); every rule has at least one example.`);

async function signIn() {
  if (process.env.DEMO_EMAIL) {
    return request('POST', '/api/auth/login', '', {
      email: process.env.DEMO_EMAIL,
      password: process.env.DEMO_PASSWORD || ''
    });
  }
  const suffix = Date.now().toString(36);
  const password = `Demo!${randomBytes(12).toString('base64url')}`;
  const email = `demo-${suffix}@demo.example`;
  const created = await request('POST', '/api/auth/register', '', {
    orgName: `Issues Demo ${suffix}`,
    name: 'Demo Admin',
    email,
    password,
    registrationToken: process.env.SEED_REGISTRATION_TOKEN || undefined
  });
  console.log(`Registered ${email} / ${password}`);
  return created;
}

function call(method, path, body) {
  return request(method, path, token, body);
}

async function request(method, path, bearer, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000)
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`${method} ${path} failed with ${response.status}: ${text}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : {};
}
