import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { openDatabase } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';
import {
  readJson,
  readMultipartForm,
  sendJson,
  sendError,
  badRequest,
  unauthorized,
  notFound
} from './http.js';
import { buildSaasImportPreview } from './import-service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const publicDir = join(rootDir, 'public');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8090);
if (!process.env.SAAS_JWT_SECRET) {
  throw new Error('SAAS_JWT_SECRET is required. Generate one with: openssl rand -hex 32');
}
const isProduction = process.env.NODE_ENV === 'production';
// Registration has three states: closed, gated behind a shared token so pilots
// can still be provisioned, or fully open for local development. A production
// host never opens itself: without an explicit opt-in it needs the token, and
// with neither it stays closed.
const registrationToken = process.env.SAAS_REGISTRATION_TOKEN || '';
const allowRegistration = process.env.SAAS_ALLOW_REGISTRATION
  ? process.env.SAAS_ALLOW_REGISTRATION === 'true'
  : !isProduction || Boolean(registrationToken);
// Invitation links must not be built from a client-supplied Host header.
const publicUrl = String(process.env.SAAS_PUBLIC_URL || '').trim().replace(/\/+$/, '');
if (isProduction && !publicUrl) {
  console.warn('SAAS_PUBLIC_URL is not set; invitation links fall back to the request Host header.');
}
// An unparseable limit must fall back to the default, not to NaN, because every
// size comparison against NaN is false and would disable the limit entirely.
const maxUploadMb = Number(process.env.SAAS_MAX_UPLOAD_MB);
const maxUploadBytes = (Number.isFinite(maxUploadMb) && maxUploadMb > 0 ? maxUploadMb : 10) * 1024 * 1024;
// Render puts exactly one proxy in front of us; it appends the peer address to
// any client-supplied X-Forwarded-For, so only the trailing entries are trusted.
const trustedProxies = Math.max(0, Number(process.env.SAAS_TRUSTED_PROXIES) || 0);

const db = await openDatabase();
const rateLimits = new Map();
// Verified against when no user matches, so login spends the same time on an
// unknown address as on a wrong password.
const decoyPasswordHash = hashPassword(randomBytes(32).toString('hex'));

const server = createServer(async (req, res) => {
  try {
    addSecurityHeaders(req, res);
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
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  });
}

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

  if (method === 'GET' && path === '/api/ready') {
    // Unauthenticated and it touches the database, so an uptime probe is fine
    // but a flood must not become free query load.
    enforceRateLimit(req, 'ready', 60, 60_000);
    return sendJson(res, await readiness());
  }

  if (method === 'POST' && path === '/api/auth/register') {
    if (!allowRegistration) {
      const error = new Error('Self-service registration is disabled. Ask for an invitation.');
      error.status = 403;
      throw error;
    }
    enforceRateLimit(req, 'auth', 20, 15 * 60_000);
    const input = await readJson(req);
    if (registrationToken && !matchesSecret(input.registrationToken, registrationToken)) {
      const error = new Error('A valid registration token is required.');
      error.status = 403;
      throw error;
    }
    return sendJson(res, await register(input), 201);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    enforceRateLimit(req, 'auth', 20, 15 * 60_000);
    return sendJson(res, await login(await readJson(req)));
  }

  if (method === 'POST' && path === '/api/invitations/accept') {
    enforceRateLimit(req, 'auth', 20, 15 * 60_000);
    return sendJson(res, await acceptInvitation(await readJson(req)));
  }

  const session = await requireSession(req);

  if (method === 'GET' && path === '/api/me') {
    return sendJson(res, await getMe(session));
  }

  if (method === 'POST' && path === '/api/auth/switch-organization') {
    return sendJson(res, await switchOrganization(session, await readJson(req)));
  }

  if (path === '/api/members' && method === 'GET') {
    requireRole(session, ['admin', 'it']);
    return sendJson(res, await listMembers(session.organizationId));
  }

  if (path === '/api/invitations' && method === 'POST') {
    requireRole(session, ['admin']);
    const invitation = await createInvitation(session, await readJson(req), req);
    return sendJson(res, invitation, 201);
  }

  if (method === 'PUT' && path.startsWith('/api/members/') && path.endsWith('/role')) {
    requireRole(session, ['admin']);
    const userId = path.split('/')[3];
    return sendJson(res, await updateMemberRole(session, userId, await readJson(req)));
  }

  if (method === 'DELETE' && path.startsWith('/api/members/')) {
    requireRole(session, ['admin']);
    return sendJson(res, await removeMember(session, path.split('/')[3]));
  }

  if (method === 'PUT' && path === '/api/me/password') {
    return sendJson(res, await changePassword(session, await readJson(req)));
  }

  if (method === 'DELETE' && path === '/api/organizations/current') {
    requireRole(session, ['admin']);
    return sendJson(res, await deleteCurrentOrganization(session, await readJson(req)));
  }

  if (path === '/api/audit' && method === 'GET') {
    requireRole(session, ['admin', 'it']);
    return sendJson(res, await listAuditLogs(session.organizationId));
  }

  if (method === 'POST' && path === '/api/import/preview') {
    requireRole(session, ['admin', 'it']);
    enforceRateLimit(req, 'upload', 30, 60 * 60_000);
    const upload = await readMultipartForm(req, maxUploadBytes);
    if (!upload.file.originalName.toLowerCase().endsWith('.csv')) {
      throw badRequest('Only CSV files are supported in the SaaS MVP');
    }
    const preview = await createImportPreview(session, upload);
    return sendJson(res, preview, 201);
  }

  if (method === 'POST' && path === '/api/import/apply') {
    requireRole(session, ['admin', 'it']);
    return sendJson(res, await applyImportBatch(session, await readJson(req)));
  }

  if (path === '/api/people') {
    if (method === 'GET') return sendJson(res, await listPeople(session.organizationId));
    if (method === 'POST') {
      requireRole(session, ['admin', 'it']);
      const person = await createPerson(session.organizationId, await readJson(req));
      await addAudit(session, 'person.create', 'person', person.id);
      return sendJson(res, person, 201);
    }
  }

  if (method === 'PUT' && path.startsWith('/api/people/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[3];
    const person = await updatePerson(session.organizationId, id, await readJson(req));
    await addAudit(session, 'person.update', 'person', id);
    return sendJson(res, person);
  }

  if (method === 'DELETE' && path.startsWith('/api/people/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[3];
    await deletePerson(session.organizationId, id);
    await addAudit(session, 'person.delete', 'person', id);
    return sendJson(res, { ok: true, id });
  }

  if (path === '/api/assets') {
    if (method === 'GET') return sendJson(res, await listAssets(session.organizationId));
    if (method === 'POST') {
      requireRole(session, ['admin', 'it']);
      const asset = await createAsset(session.organizationId, await readJson(req));
      await addAudit(session, 'asset.create', 'asset', asset.id);
      return sendJson(res, asset, 201);
    }
  }

  if (method === 'PUT' && path.startsWith('/api/assets/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[3];
    const { asset, assignmentChange } = await updateAsset(
      session.organizationId,
      id,
      await readJson(req)
    );
    await addAudit(
      session,
      assignmentChange ? 'asset.assign' : 'asset.update',
      'asset',
      id,
      assignmentChange || {}
    );
    return sendJson(res, asset);
  }

  if (method === 'DELETE' && path.startsWith('/api/assets/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[3];
    await deleteAsset(session.organizationId, id);
    await addAudit(session, 'asset.delete', 'asset', id);
    return sendJson(res, { ok: true, id });
  }

  throw notFound('API route not found');
}

async function requireSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyToken(token);
  if (!payload?.sub || !payload?.org) throw unauthorized();
  const membership = await db.get(`
    SELECT m.role, u.token_epoch AS "tokenEpoch"
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.organization_id = ?
  `, [payload.sub, payload.org]);
  if (!membership) throw unauthorized();
  // Tokens issued before the current epoch belong to a session that was ended
  // by a password change. Tokens minted before this claim existed read as 0,
  // which is also the default epoch, so they keep working.
  if (Number(payload.epoch || 0) !== Number(membership.tokenEpoch || 0)) throw unauthorized();
  return {
    userId: payload.sub,
    organizationId: payload.org,
    role: membership.role
  };
}

// Uptime probes poll readiness continuously; a short cache keeps a burst from
// becoming one database round trip per request.
let readinessCache = { expiresAt: 0, payload: null };

async function readiness() {
  const now = Date.now();
  if (readinessCache.payload && readinessCache.expiresAt > now) return readinessCache.payload;
  await db.ping();
  const payload = { ok: true, database: db.dialect };
  readinessCache = { expiresAt: now + 5_000, payload };
  return payload;
}

function requireRole(session, allowedRoles) {
  if (!allowedRoles.includes(session.role)) {
    const error = new Error('Insufficient permissions');
    error.status = 403;
    throw error;
  }
}

async function register(input) {
  const orgName = clean(input.orgName);
  const email = clean(input.email).toLowerCase();
  const password = String(input.password || '');
  const name = clean(input.name) || email;
  if (!orgName || !email || password.length < 8) {
    throw badRequest('orgName, email and password (min 8 chars) are required');
  }

  const existing = await db.get('SELECT id FROM users WHERE LOWER(email) = LOWER(?)', [email]);
  if (existing) throw badRequest('Email already registered');

  const now = new Date().toISOString();
  const orgId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const slug = await uniqueSlug(slugify(orgName));

  await db.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO organizations (id, name, slug, created_at)
      VALUES (?, ?, ?, ?)
    `, [orgId, orgName, slug, now]);

    await tx.run(`
      INSERT INTO users (id, email, name, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [userId, email, name, hashPassword(password), now]);

    await tx.run(`
      INSERT INTO memberships (id, organization_id, user_id, role, created_at)
      VALUES (?, ?, ?, 'admin', ?)
    `, [membershipId, orgId, userId, now]);
  }).catch((error) => {
    if (isUniqueViolation(error)) throw badRequest('Email or organization slug already exists');
    throw error;
  });

  const token = signToken({ sub: userId, org: orgId, role: 'admin', email, epoch: 0 });
  return {
    token,
    user: { id: userId, email, name },
    organization: { id: orgId, name: orgName }
  };
}

async function login(input) {
  const email = clean(input.email).toLowerCase();
  const password = String(input.password || '');
  const user = await db.get('SELECT * FROM users WHERE LOWER(email) = LOWER(?)', [email]);
  // An unknown address must cost the same as a wrong password. Skipping the
  // hash when the user is missing answers in microseconds instead of tens of
  // milliseconds, which enumerates who has an account here.
  const passwordMatches = verifyPassword(password, user ? user.password_hash : decoyPasswordHash);
  if (!user || !passwordMatches) {
    throw unauthorized('Invalid email or password');
  }
  const memberships = await listUserOrganizations(user.id);
  if (!memberships.length) throw unauthorized('User has no organization');
  const requestedOrgId = clean(input.organizationId);
  if (!requestedOrgId && memberships.length > 1) {
    return {
      requiresOrganization: true,
      user: { id: user.id, email: user.email, name: user.name },
      organizations: memberships
    };
  }
  const membership = requestedOrgId
    ? memberships.find((item) => item.id === requestedOrgId)
    : memberships[0];
  if (!membership) throw unauthorized('User does not belong to that organization');

  const token = signToken({
    sub: user.id,
    org: membership.id,
    role: membership.role,
    email: user.email,
    epoch: Number(user.token_epoch || 0)
  });
  return {
    token,
    user: { id: user.id, email: user.email, name: user.name },
    organization: { id: membership.id, name: membership.name },
    role: membership.role
  };
}

async function getMe(session) {
  const user = await db.get('SELECT id, email, name FROM users WHERE id = ?', [session.userId]);
  const org = await db.get('SELECT id, name, slug FROM organizations WHERE id = ?', [session.organizationId]);
  if (!user || !org) throw unauthorized();
  return {
    user,
    organization: org,
    organizations: await listUserOrganizations(session.userId),
    role: session.role
  };
}

async function listUserOrganizations(userId) {
  return db.all(`
    SELECT o.id, o.name, o.slug, m.role
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ?
    ORDER BY LOWER(o.name)
  `, [userId]);
}

async function switchOrganization(session, input) {
  const organizationId = clean(input.organizationId);
  const membership = await db.get(`
    SELECT m.role, o.id, o.name
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ? AND m.organization_id = ?
  `, [session.userId, organizationId]);
  if (!membership) throw unauthorized('User does not belong to that organization');
  const user = await db.get(
    'SELECT id, email, name, token_epoch AS "tokenEpoch" FROM users WHERE id = ?',
    [session.userId]
  );
  return {
    token: signToken({
      sub: user.id,
      org: membership.id,
      role: membership.role,
      email: user.email,
      epoch: Number(user.tokenEpoch || 0)
    }),
    user: { id: user.id, email: user.email, name: user.name },
    organization: { id: membership.id, name: membership.name },
    role: membership.role
  };
}

async function listMembers(organizationId) {
  return db.all(`
    SELECT u.id, u.email, u.name, m.role, m.created_at AS createdAt
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ?
    ORDER BY LOWER(u.name), LOWER(u.email)
  `, [organizationId]);
}

async function createInvitation(session, input, req) {
  const email = clean(input.email).toLowerCase();
  const role = ['admin', 'it', 'readonly'].includes(input.role) ? input.role : 'readonly';
  if (!email || !email.includes('@')) throw badRequest('Valid email is required');
  const existingMember = await db.get(`
    SELECT 1
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ? AND LOWER(u.email) = LOWER(?)
  `, [session.organizationId, email]);
  if (existingMember) throw badRequest('User is already a member');

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const id = randomUUID();
  await db.run(`
    INSERT INTO invitations (
      id, organization_id, email, role, token_hash, invited_by, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    session.organizationId,
    email,
    role,
    tokenHash,
    session.userId,
    expiresAt,
    now.toISOString()
  ]);
  await addAudit(session, 'invitation.create', 'invitation', id, { email, role });

  return {
    id,
    email,
    role,
    expiresAt,
    inviteUrl: `${inviteBaseUrl(req)}/?invite=${encodeURIComponent(token)}`
  };
}

function inviteBaseUrl(req) {
  if (publicUrl) return publicUrl;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || 'http';
  return `${protocol}://${req.headers.host || `localhost:${port}`}`;
}

async function acceptInvitation(input) {
  const token = clean(input.token);
  const password = String(input.password || '');
  if (!token) throw badRequest('Invitation token is required');
  const invitation = await db.get(`
    SELECT i.*, o.name AS organization_name
    FROM invitations i
    JOIN organizations o ON o.id = i.organization_id
    WHERE i.token_hash = ?
  `, [hashToken(token)]);
  if (!invitation || invitation.accepted_at || invitation.expires_at < new Date().toISOString()) {
    throw badRequest('Invitation is invalid or expired');
  }

  let user = await db.get(
    'SELECT * FROM users WHERE LOWER(email) = LOWER(?)',
    [invitation.email]
  );
  if (user) {
    if (!verifyPassword(password, user.password_hash)) {
      throw unauthorized('Use the existing account password to accept this invitation');
    }
  } else {
    if (password.length < 8) throw badRequest('Password must have at least 8 characters');
    user = {
      id: randomUUID(),
      email: invitation.email,
      name: clean(input.name) || invitation.email
    };
  }

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    if (!await tx.get('SELECT id FROM users WHERE id = ?', [user.id])) {
      await tx.run(`
        INSERT INTO users (id, email, name, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `, [user.id, user.email, user.name, hashPassword(password), now]);
    }
    await tx.run(`
      INSERT INTO memberships (
        id, organization_id, user_id, role, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (organization_id, user_id) DO NOTHING
    `, [randomUUID(), invitation.organization_id, user.id, invitation.role, now]);
    await tx.run(`
      UPDATE invitations SET accepted_at = ? WHERE id = ?
    `, [now, invitation.id]);
  });

  const auditSession = {
    organizationId: invitation.organization_id,
    userId: user.id
  };
  await addAudit(auditSession, 'invitation.accept', 'invitation', invitation.id, {
    email: invitation.email,
    role: invitation.role
  });
  const epoch = Number(
    (await db.get('SELECT token_epoch AS "tokenEpoch" FROM users WHERE id = ?', [user.id]))?.tokenEpoch || 0
  );
  return {
    token: signToken({
      sub: user.id,
      org: invitation.organization_id,
      role: invitation.role,
      email: user.email,
      epoch
    }),
    user: { id: user.id, email: user.email, name: user.name },
    organization: { id: invitation.organization_id, name: invitation.organization_name },
    role: invitation.role
  };
}

async function updateMemberRole(session, userId, input) {
  const role = clean(input.role);
  if (!['admin', 'it', 'readonly'].includes(role)) throw badRequest('Invalid role');
  const membership = await db.get(`
    SELECT id, role FROM memberships
    WHERE organization_id = ? AND user_id = ?
  `, [session.organizationId, userId]);
  if (!membership) throw notFound('Member not found');
  if (membership.role === 'admin' && role !== 'admin') {
    const adminCount = (await db.get(`
      SELECT COUNT(*) AS count FROM memberships
      WHERE organization_id = ? AND role = 'admin'
    `, [session.organizationId])).count;
    if (Number(adminCount) <= 1) throw badRequest('Organization must keep at least one admin');
  }
  await db.run('UPDATE memberships SET role = ? WHERE id = ?', [role, membership.id]);
  await addAudit(session, 'member.role_update', 'user', userId, {
    before: membership.role,
    after: role
  });
  return (await listMembers(session.organizationId)).find((member) => member.id === userId);
}

async function removeMember(session, userId) {
  const membership = await db.get(`
    SELECT id, role FROM memberships WHERE organization_id = ? AND user_id = ?
  `, [session.organizationId, userId]);
  if (!membership) throw notFound('Member not found');
  if (membership.role === 'admin' && await isLastAdmin(session.organizationId)) {
    throw badRequest('Organization must keep at least one admin');
  }

  const removed = await db.get('SELECT email FROM users WHERE id = ?', [userId]);
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM memberships WHERE id = ?', [membership.id]);
    await deleteUserWithoutOrganizations(tx, userId);
  });
  await addAudit(session, 'member.remove', 'user', userId, {
    email: removed?.email || '',
    role: membership.role
  });
  return { ok: true, id: userId };
}

async function isLastAdmin(organizationId) {
  const row = await db.get(`
    SELECT COUNT(*) AS count FROM memberships
    WHERE organization_id = ? AND role = 'admin'
  `, [organizationId]);
  return Number(row.count) <= 1;
}

// An account that belongs to no organization has no way back into the product
// and nothing left to authorise, so leaving the row behind would only keep a
// personal e-mail address on file.
async function deleteUserWithoutOrganizations(tx, userId) {
  const remaining = await tx.get(
    'SELECT 1 AS present FROM memberships WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (remaining) return false;
  await tx.run('DELETE FROM users WHERE id = ?', [userId]);
  return true;
}

async function changePassword(session, input) {
  const currentPassword = String(input.currentPassword || '');
  const newPassword = String(input.newPassword || '');
  if (newPassword.length < 8) throw badRequest('newPassword must have at least 8 characters');
  const user = await db.get('SELECT * FROM users WHERE id = ?', [session.userId]);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    throw unauthorized('Current password is incorrect');
  }
  const epoch = Number(user.token_epoch || 0) + 1;
  await db.run(
    'UPDATE users SET password_hash = ?, token_epoch = ? WHERE id = ?',
    [hashPassword(newPassword), epoch, session.userId]
  );
  await addAudit(session, 'user.password_change', 'user', session.userId);

  // Every previously issued token, including the one that made this request,
  // is now rejected, so hand back a fresh one to avoid logging the caller out.
  return {
    ok: true,
    token: signToken({
      sub: user.id,
      org: session.organizationId,
      role: session.role,
      email: user.email,
      epoch
    })
  };
}

async function deleteCurrentOrganization(session, input) {
  const organization = await db.get(
    'SELECT id, name FROM organizations WHERE id = ?',
    [session.organizationId]
  );
  if (!organization) throw notFound('Organization not found');
  // Deleting cascades through people, devices, imports and the audit log, so
  // the caller has to name what is being destroyed.
  if (clean(input.confirm) !== organization.name) {
    throw badRequest('confirm must repeat the organization name exactly');
  }

  const memberIds = (await db.all(
    'SELECT user_id AS "userId" FROM memberships WHERE organization_id = ?',
    [organization.id]
  )).map((row) => row.userId);

  let deletedUsers = 0;
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM organizations WHERE id = ?', [organization.id]);
    for (const userId of memberIds) {
      if (await deleteUserWithoutOrganizations(tx, userId)) deletedUsers += 1;
    }
  });
  return { ok: true, id: organization.id, name: organization.name, deletedUsers };
}

async function listAuditLogs(organizationId) {
  return (await db.all(`
    SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
           a.details_json AS "detailsJson", a.created_at AS "createdAt",
           u.email AS "userEmail"
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.organization_id = ?
    ORDER BY a.created_at DESC
    LIMIT 200
  `, [organizationId])).map((row) => ({
    ...row,
    details: JSON.parse(row.detailsJson || '{}'),
    detailsJson: undefined
  }));
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function listPeople(organizationId) {
  return db.all(`
    SELECT id, first_name AS "firstName", last_name AS "lastName", email, department,
           role_title AS role, status, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM people
    WHERE organization_id = ?
    ORDER BY LOWER(last_name), LOWER(first_name)
  `, [organizationId]);
}

async function createPerson(organizationId, input) {
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  if (!firstName || !lastName) throw badRequest('firstName and lastName are required');
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.run(`
    INSERT INTO people (
      id, organization_id, first_name, last_name, email, department, role_title, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
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
  ]);
  return (await listPeople(organizationId)).find((person) => person.id === id);
}

async function updatePerson(organizationId, id, input) {
  const existing = await db.get(
    'SELECT * FROM people WHERE id = ? AND organization_id = ?',
    [id, organizationId]
  );
  if (!existing) throw notFound('Person not found');

  const firstName = pick(input.firstName, existing.first_name);
  const lastName = pick(input.lastName, existing.last_name);
  if (!firstName || !lastName) throw badRequest('firstName and lastName are required');
  const status = input.status === undefined
    ? existing.status
    : (input.status === 'inactive' ? 'inactive' : 'active');

  await db.run(`
    UPDATE people
    SET first_name = ?, last_name = ?, email = ?, department = ?, role_title = ?,
        status = ?, updated_at = ?
    WHERE id = ? AND organization_id = ?
  `, [
    firstName,
    lastName,
    pick(input.email, existing.email).toLowerCase(),
    pick(input.department, existing.department),
    pick(input.role, existing.role_title),
    status,
    new Date().toISOString(),
    id,
    organizationId
  ]);
  return (await listPeople(organizationId)).find((person) => person.id === id);
}

async function deletePerson(organizationId, id) {
  const result = await db.run(
    'DELETE FROM people WHERE id = ? AND organization_id = ?',
    [id, organizationId]
  );
  if (!result.changes) throw notFound('Person not found');
}

async function listAssets(organizationId) {
  return db.all(`
    SELECT a.id, a.asset_tag AS "assetTag", a.serial_number AS "serialNumber", a.model_name AS "modelName",
           a.status, a.person_id AS "personId", a.created_at AS "createdAt", a.updated_at AS "updatedAt",
           p.first_name AS "personFirstName", p.last_name AS "personLastName"
    FROM assets a
    LEFT JOIN people p ON p.id = a.person_id AND p.organization_id = a.organization_id
    WHERE a.organization_id = ?
    ORDER BY LOWER(a.asset_tag)
  `, [organizationId]);
}

async function createAsset(organizationId, input) {
  const assetTag = clean(input.assetTag);
  const serialNumber = clean(input.serialNumber);
  if (!assetTag || !serialNumber) throw badRequest('assetTag and serialNumber are required');
  const now = new Date().toISOString();
  const id = randomUUID();
  const personId = clean(input.personId) || null;
  if (personId) {
    const person = await db.get(`
      SELECT id FROM people WHERE id = ? AND organization_id = ?
    `, [personId, organizationId]);
    if (!person) throw badRequest('Person does not belong to this organization');
  }
  try {
    await db.run(`
      INSERT INTO assets (
        id, organization_id, asset_tag, serial_number, model_name, status, person_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      organizationId,
      assetTag,
      serialNumber,
      clean(input.modelName),
      personId ? 'assigned' : normalizeStatus(input.status),
      personId,
      now,
      now
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw badRequest('assetTag or serialNumber already exists in this organization');
    }
    throw error;
  }
  return (await listAssets(organizationId)).find((asset) => asset.id === id);
}

async function updateAsset(organizationId, id, input) {
  const existing = await db.get(
    'SELECT * FROM assets WHERE id = ? AND organization_id = ?',
    [id, organizationId]
  );
  if (!existing) throw notFound('Asset not found');

  const assetTag = pick(input.assetTag, existing.asset_tag);
  const serialNumber = pick(input.serialNumber, existing.serial_number);
  if (!assetTag || !serialNumber) throw badRequest('assetTag and serialNumber are required');

  let personId = existing.person_id;
  if (input.personId !== undefined) {
    personId = clean(input.personId) || null;
    if (personId) {
      const person = await db.get(
        'SELECT id FROM people WHERE id = ? AND organization_id = ?',
        [personId, organizationId]
      );
      if (!person) throw badRequest('Person does not belong to this organization');
    }
  }

  // Assigning always marks the device assigned; handing it back returns it to
  // stock unless the caller asked for another status, such as service.
  let status;
  if (personId) status = 'assigned';
  else if (input.status !== undefined) status = normalizeStatus(input.status);
  else status = existing.person_id ? 'in_stock' : existing.status;

  try {
    await db.run(`
      UPDATE assets
      SET asset_tag = ?, serial_number = ?, model_name = ?, status = ?, person_id = ?, updated_at = ?
      WHERE id = ? AND organization_id = ?
    `, [
      assetTag,
      serialNumber,
      pick(input.modelName, existing.model_name),
      status,
      personId,
      new Date().toISOString(),
      id,
      organizationId
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw badRequest('assetTag or serialNumber already exists in this organization');
    }
    throw error;
  }

  const asset = (await listAssets(organizationId)).find((item) => item.id === id);
  const assignmentChange = (existing.person_id || null) === personId
    ? null
    : { from: existing.person_id || null, to: personId, status };
  return { asset, assignmentChange };
}

async function deleteAsset(organizationId, id) {
  const result = await db.run(
    'DELETE FROM assets WHERE id = ? AND organization_id = ?',
    [id, organizationId]
  );
  if (!result.changes) throw notFound('Asset not found');
}

async function createImportPreview(session, upload) {
  const [existingAssets, existingPeople] = await Promise.all([
    listAssets(session.organizationId),
    listPeople(session.organizationId)
  ]);
  const preview = buildSaasImportPreview({
    buffer: upload.file.buffer,
    fileName: upload.file.originalName,
    source: upload.fields.source || 'auto',
    existingAssets,
    existingPeople
  });
  const batchId = randomUUID();
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO import_batches (
        id, organization_id, user_id, source, file_name, status, summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'preview', ?, ?)
    `, [
      batchId,
      session.organizationId,
      session.userId,
      preview.source,
      preview.fileName,
      JSON.stringify(preview.summary),
      now
    ]);

    const storedRows = [];
    for (const row of preview.rows) {
      const id = randomUUID();
      await tx.run(`
        INSERT INTO import_rows (
          id, batch_id, organization_id, row_key, action, data_json, warnings_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        id,
        batchId,
        session.organizationId,
        row.rowKey,
        row.action,
        JSON.stringify(row),
        JSON.stringify(row.warnings),
        now
      ]);
      storedRows.push({ ...row, id });
    }
    preview.rows = storedRows;
  });

  await addAudit(session, 'import.preview', 'import_batch', batchId, {
    source: preview.source,
    fileName: preview.fileName,
    summary: preview.summary
  });
  return { ...preview, batchId };
}

async function applyImportBatch(session, input) {
  const batchId = clean(input.batchId);
  if (!batchId) throw badRequest('batchId is required');
  const batch = await db.get(`
    SELECT * FROM import_batches
    WHERE id = ? AND organization_id = ?
  `, [batchId, session.organizationId]);
  if (!batch) throw notFound('Import batch not found');
  if (batch.status !== 'preview') throw badRequest('Import batch was already applied or cancelled');

  const rows = await db.all(`
    SELECT id, action, data_json AS "dataJson"
    FROM import_rows
    WHERE batch_id = ? AND organization_id = ?
    ORDER BY created_at, id
  `, [batchId, session.organizationId]);
  const includeIds = Array.isArray(input.includeRowIds)
    ? new Set(input.includeRowIds.map(clean))
    : null;
  const selected = rows.filter((row) =>
    row.action !== 'skip' && (!includeIds || includeIds.has(row.id))
  );
  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  let peopleCreated = 0;

  await db.transaction(async (tx) => {
    for (const stored of selected) {
      const row = JSON.parse(stored.dataJson);
      let personId = null;
      const personEmail = clean(row.person?.email).toLowerCase();
      if (personEmail) {
        let person = await tx.get(`
          SELECT id FROM people
          WHERE organization_id = ? AND LOWER(email) = LOWER(?)
          LIMIT 1
        `, [session.organizationId, personEmail]);
        if (!person) {
          person = { id: randomUUID() };
          await tx.run(`
            INSERT INTO people (
              id, organization_id, first_name, last_name, email, department,
              role_title, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
          `, [
            person.id,
            session.organizationId,
            clean(row.person.firstName) || 'Unknown',
            clean(row.person.lastName) || '-',
            personEmail,
            clean(row.person.department),
            clean(row.person.role),
            now,
            now
          ]);
          peopleCreated += 1;
        }
        personId = person.id;
      }

      const existing = await tx.get(`
        SELECT id, status FROM assets
        WHERE organization_id = ? AND LOWER(serial_number) = LOWER(?)
      `, [session.organizationId, row.serialNumber]);
      if (existing) {
        await tx.run(`
          UPDATE assets
          SET asset_tag = ?, model_name = ?, status = ?, person_id = ?, updated_at = ?
          WHERE id = ? AND organization_id = ?
        `, [
          row.assetTag,
          row.modelName,
          personId ? 'assigned' : existing.status,
          personId,
          now,
          existing.id,
          session.organizationId
        ]);
        updated += 1;
      } else {
        await tx.run(`
          INSERT INTO assets (
            id, organization_id, asset_tag, serial_number, model_name,
            status, person_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          randomUUID(),
          session.organizationId,
          row.assetTag,
          row.serialNumber,
          row.modelName,
          personId ? 'assigned' : 'in_stock',
          personId,
          now,
          now
        ]);
        created += 1;
      }
    }

    await tx.run(`
      UPDATE import_batches
      SET status = 'applied', applied_at = ?, summary_json = ?
      WHERE id = ? AND organization_id = ?
    `, [
      now,
      JSON.stringify({
        created,
        updated,
        peopleCreated,
        skipped: rows.length - selected.length
      }),
      batchId,
      session.organizationId
    ]);
  }).catch((error) => {
    if (isUniqueViolation(error)) {
      throw badRequest('The import conflicts with an existing serial number or asset tag');
    }
    throw error;
  });

  const summary = {
    created,
    updated,
    peopleCreated,
    skipped: rows.length - selected.length
  };
  await addAudit(session, 'import.apply', 'import_batch', batchId, summary);
  return { ok: true, batchId, summary };
}

async function addAudit(session, action, entityType, entityId = '', details = {}) {
  await db.run(`
    INSERT INTO audit_logs (
      id, organization_id, user_id, action, entity_type, entity_id, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    randomUUID(),
    session.organizationId,
    session.userId,
    action,
    entityType,
    entityId || null,
    JSON.stringify(details || {}),
    new Date().toISOString()
  ]);
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

// Updates are partial: an omitted field keeps the stored value, while an empty
// string is a deliberate clear.
function pick(provided, current) {
  return provided === undefined ? clean(current) : clean(provided);
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

async function uniqueSlug(base) {
  let slug = base;
  let i = 2;
  while (await db.get('SELECT id FROM organizations WHERE slug = ?', [slug])) {
    slug = `${base}-${i}`;
    i += 1;
  }
  return slug;
}

function normalizeStatus(status) {
  const value = clean(status);
  return ['in_stock', 'assigned', 'deployed', 'service', 'retired'].includes(value) ? value : 'in_stock';
}

function isUniqueViolation(error) {
  return error?.code === '23505' || String(error?.message || '').toLowerCase().includes('unique');
}

function enforceRateLimit(req, bucket, limit, windowMs) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    cleanupRateLimits(now);
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    const error = new Error('Too many requests. Try again later.');
    error.status = 429;
    throw error;
  }
}

function matchesSecret(provided, expected) {
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clientIp(req) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  if (!trustedProxies) return socketIp;
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return forwarded[forwarded.length - trustedProxies] || socketIp;
}

function cleanupRateLimits(now) {
  if (rateLimits.size < 1_000) return;
  for (const [key, value] of rateLimits) {
    if (value.resetAt <= now) rateLimits.delete(key);
  }
}

function addSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
  );
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwardedProto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
