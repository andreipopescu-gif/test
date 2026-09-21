import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from '../src/auth.js';

test('password hash verifies', () => {
  const stored = hashPassword('secret-pass');
  assert.equal(verifyPassword('secret-pass', stored), true);
  assert.equal(verifyPassword('wrong', stored), false);
});

test('jwt roundtrip', () => {
  process.env.SAAS_JWT_SECRET = 'test-secret-for-jwt-roundtrip';
  const token = signToken({ sub: 'u1', org: 'o1', role: 'admin' }, 60);
  const payload = verifyToken(token);
  assert.equal(payload.sub, 'u1');
  assert.equal(payload.org, 'o1');
});

test('sqlite schema creates organizations table', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'saas-db-'));
  const db = await openDatabase({ dbPath: join(dir, 't.sqlite'), databaseUrl: '' });
  const row = await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='organizations'`);
  assert.equal(row.name, 'organizations');
  await db.close();
  await rm(dir, { recursive: true, force: true });
});
