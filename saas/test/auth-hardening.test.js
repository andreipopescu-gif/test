import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const saasDir = join(__dirname, '..');

test('a production host does not open registration by itself', { timeout: 20_000 }, async () => {
  await withServer({ NODE_ENV: 'production' }, async (baseUrl) => {
    const response = await post(baseUrl, '/api/auth/register', {
      orgName: 'Walk In',
      email: 'walkin@example.test',
      password: 'password-walkin'
    });
    assert.equal(response.status, 403);
  });
});

test('a registration token provisions a pilot without opening the host', { timeout: 20_000 }, async () => {
  await withServer({ NODE_ENV: 'production', SAAS_REGISTRATION_TOKEN: 'pilot-token' }, async (baseUrl) => {
    const rejected = await post(baseUrl, '/api/auth/register', {
      orgName: 'No Token',
      email: 'notoken@example.test',
      password: 'password-notoken'
    });
    assert.equal(rejected.status, 403);

    const accepted = await post(baseUrl, '/api/auth/register', {
      orgName: 'With Token',
      email: 'withtoken@example.test',
      password: 'password-withtoken',
      registrationToken: 'pilot-token'
    });
    assert.equal(accepted.status, 201);
  });
});

test('invitation links come from the configured public URL, not the Host header', { timeout: 20_000 }, async () => {
  await withServer({ SAAS_PUBLIC_URL: 'https://inventory.example.eu/' }, async (baseUrl) => {
    const registered = await post(baseUrl, '/api/auth/register', {
      orgName: 'Invite Co',
      email: 'admin@invite.test',
      password: 'password-invite'
    });
    assert.equal(registered.status, 201);
    const { token } = await registered.json();

    const response = await fetch(`${baseUrl}/api/invitations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Host: 'attacker.example.com'
      },
      body: JSON.stringify({ email: 'guest@invite.test', role: 'readonly' })
    });
    assert.equal(response.status, 201);
    const invitation = await response.json();
    assert.match(invitation.inviteUrl, /^https:\/\/inventory\.example\.eu\/#invite=/);
  });
});

// A missing account used to skip password hashing entirely, so the response
// time said whether an address was registered here.
test('an unknown email costs the same as a wrong password', { timeout: 30_000 }, async () => {
  await withServer({}, async (baseUrl) => {
    const registered = await post(baseUrl, '/api/auth/register', {
      orgName: 'Timing Co',
      email: 'known@timing.test',
      password: 'password-known'
    });
    assert.equal(registered.status, 201);

    const known = await medianLoginMs(baseUrl, 'known@timing.test');
    const unknown = await medianLoginMs(baseUrl, 'missing@timing.test');
    assert.ok(
      unknown > known * 0.5,
      `unknown-account login answered in ${unknown.toFixed(1)}ms versus ${known.toFixed(1)}ms for a known account`
    );
  });
});

async function medianLoginMs(baseUrl, email) {
  const samples = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const startedAt = process.hrtime.bigint();
    const response = await post(baseUrl, '/api/auth/login', { email, password: 'definitely-wrong' });
    assert.equal(response.status, 401);
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function withServer(env, run) {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-saas-auth-'));
  const port = 19_000 + Math.floor(Math.random() * 1_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: saasDir,
    env: {
      ...process.env,
      SAAS_ALLOW_REGISTRATION: '',
      SAAS_REGISTRATION_TOKEN: '',
      SAAS_PUBLIC_URL: '',
      NODE_ENV: '',
      ...env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SAAS_DB_PATH: join(dir, 'saas.sqlite'),
      SAAS_JWT_SECRET: 'auth-hardening-test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    await waitForHealth(baseUrl);
    await run(baseUrl);
  } catch (error) {
    error.message += `\nServer output:\n${output}`;
    throw error;
  } finally {
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
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
