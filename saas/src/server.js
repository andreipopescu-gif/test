import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';
import { readJson, sendJson, sendError, badRequest, unauthorized, notFound } from './http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const publicDir = join(rootDir, 'public');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8090);

const db = openDatabase();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(port, host, () => {
  console.log(`IT Inventory SaaS MVP at http://${host}:${port}`);
});

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const path = url.pathname;

  if (method === 'GET' && path === '/api/health') {
    return sendJson(res, {
      ok: true,
      product: 'saas',
      time: new Date().toISOString()
    });
  }

  if (method === 'POST' && path === '/api/auth/register') {
    return sendJson(res, register(await readJson(req)), 201);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    return sendJson(res, login(await readJson(req)));
  }

  const session = requireSession(req);

  if (method === 'GET' && path === '/api/me') {
    return sendJson(res, getMe(session));
  }

  if (path === '/api/people') {
    if (method === 'GET') return sendJson(res, listPeople(session.organizationId));
    if (method === 'POST') return sendJson(res, createPerson(session.organizationId, await readJson(req)), 201);
  }

  if (method === 'DELETE' && path.startsWith('/api/people/')) {
    const id = path.split('/')[3];
    deletePerson(session.organizationId, id);
    return sendJson(res, { ok: true, id });
  }

  if (path === '/api/assets') {
    if (method === 'GET') return sendJson(res, listAssets(session.organizationId));
    if (method === 'POST') return sendJson(res, createAsset(session.organizationId, await readJson(req)), 201);
  }

  if (method === 'DELETE' && path.startsWith('/api/assets/')) {
    const id = path.split('/')[3];
    deleteAsset(session.organizationId, id);
    return sendJson(res, { ok: true, id });
  }

  throw notFound('API route not found');
}

function requireSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload?.sub || !payload?.org) throw unauthorized();
  return {
    userId: payload.sub,
    organizationId: payload.org,
    role: payload.role || 'readonly'
  };
}

function register(input) {
  const orgName = clean(input.orgName);
  const email = clean(input.email).toLowerCase();
  const password = String(input.password || '');
  const name = clean(input.name) || email;
  if (!orgName || !email || password.length < 8) {
    throw badRequest('orgName, email and password (min 8 chars) are required');
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw badRequest('Email already registered');

  const now = new Date().toISOString();
  const orgId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const slug = uniqueSlug(slugify(orgName));

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES (?, ?, ?, ?)
    `).run(orgId, orgName, slug, now);

    db.prepare(`
      INSERT INTO users (id, email, name, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, email, name, hashPassword(password), now);

    db.prepare(`
      INSERT INTO memberships (id, organization_id, user_id, role, created_at)
      VALUES (?, ?, ?, 'admin', ?)
    `).run(membershipId, orgId, userId, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const token = signToken({ sub: userId, org: orgId, role: 'admin', email });
  return {
    token,
    user: { id: userId, email, name },
    organization: { id: orgId, name: orgName }
  };
}

function login(input) {
  const email = clean(input.email).toLowerCase();
  const password = String(input.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw unauthorized('Invalid email or password');
  }
  const membership = db.prepare(`
    SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC LIMIT 1
  `).get(user.id);
  if (!membership) throw unauthorized('User has no organization');

  const token = signToken({
    sub: user.id,
    org: membership.organization_id,
    role: membership.role,
    email: user.email
  });
  const org = db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(membership.organization_id);
  return {
    token,
    user: { id: user.id, email: user.email, name: user.name },
    organization: org
  };
}

function getMe(session) {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(session.userId);
  const org = db.prepare('SELECT id, name, slug FROM organizations WHERE id = ?').get(session.organizationId);
  if (!user || !org) throw unauthorized();
  return { user, organization: org, role: session.role };
}

function listPeople(organizationId) {
  return db.prepare(`
    SELECT id, first_name AS firstName, last_name AS lastName, email, department,
           role_title AS role, status, created_at AS createdAt, updated_at AS updatedAt
    FROM people
    WHERE organization_id = ?
    ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
  `).all(organizationId);
}

function createPerson(organizationId, input) {
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  if (!firstName || !lastName) throw badRequest('firstName and lastName are required');
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO people (
      id, organization_id, first_name, last_name, email, department, role_title, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    organizationId,
    firstName,
    lastName,
    clean(input.email).toLowerCase(),
    clean(input.department),
    clean(input.role),
    input.status === 'inactive' ? 'inactive' : 'active',
    now,
    now
  );
  return listPeople(organizationId).find((person) => person.id === id);
}

function deletePerson(organizationId, id) {
  const result = db.prepare('DELETE FROM people WHERE id = ? AND organization_id = ?').run(id, organizationId);
  if (!result.changes) throw notFound('Person not found');
}

function listAssets(organizationId) {
  return db.prepare(`
    SELECT a.id, a.asset_tag AS assetTag, a.serial_number AS serialNumber, a.model_name AS modelName,
           a.status, a.person_id AS personId, a.created_at AS createdAt, a.updated_at AS updatedAt,
           p.first_name AS personFirstName, p.last_name AS personLastName
    FROM assets a
    LEFT JOIN people p ON p.id = a.person_id
    WHERE a.organization_id = ?
    ORDER BY a.asset_tag COLLATE NOCASE
  `).all(organizationId);
}

function createAsset(organizationId, input) {
  const assetTag = clean(input.assetTag);
  const serialNumber = clean(input.serialNumber);
  if (!assetTag || !serialNumber) throw badRequest('assetTag and serialNumber are required');
  const now = new Date().toISOString();
  const id = randomUUID();
  try {
    db.prepare(`
      INSERT INTO assets (
        id, organization_id, asset_tag, serial_number, model_name, status, person_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      organizationId,
      assetTag,
      serialNumber,
      clean(input.modelName),
      normalizeStatus(input.status),
      clean(input.personId) || null,
      now,
      now
    );
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      throw badRequest('assetTag or serialNumber already exists in this organization');
    }
    throw error;
  }
  return listAssets(organizationId).find((asset) => asset.id === id);
}

function deleteAsset(organizationId, id) {
  const result = db.prepare('DELETE FROM assets WHERE id = ? AND organization_id = ?').run(id, organizationId);
  if (!result.changes) throw notFound('Asset not found');
}

async function serveStatic(req, res, url) {
  let requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  requested = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, requested);
  if (!filePath.startsWith(publicDir)) {
    throw badRequest('Invalid path');
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600'
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const index = await readFile(join(publicDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(index);
      return;
    }
    throw error;
  }
}

function contentType(filePath) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  }[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function clean(value) {
  return String(value ?? '').trim();
}

function slugify(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'org';
}

function uniqueSlug(base) {
  let slug = base;
  let i = 2;
  while (db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)) {
    slug = `${base}-${i}`;
    i += 1;
  }
  return slug;
}

function normalizeStatus(status) {
  const value = clean(status);
  return ['in_stock', 'assigned', 'deployed', 'service', 'retired'].includes(value) ? value : 'in_stock';
}
