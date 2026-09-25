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
import { buildSaasImportPreview, buildSaasUserImportPreview } from './import-service.js';
import {
  createBrand,
  createCatalogModel,
  createCategory,
  deleteBrand,
  deleteCategory,
  deleteModel,
  listCatalog,
  resetDefaults,
  updateBrand,
  updateCategory,
  updateModel
} from './catalog.js';
import {
  countsAs,
  createCustomField,
  createOption,
  deleteCustomField,
  deleteOption,
  ensureDepartmentOption,
  listAllOptions,
  listCustomFields,
  listOptions,
  updateCustomField,
  updateOption,
  validateCustomFields,
  validateLocation,
  validateStatus
} from './options.js';
import {
  createImportProfile,
  deleteImportProfile,
  listImportProfiles,
  updateImportProfile
} from './import-profiles.js';
import { listPresets } from './import/mdm-presets.js';
import {
  getException,
  listExceptions,
  loadRuleSettings,
  runExceptionScan,
  saveRuleSettings,
  summarizeExceptions,
  updateException
} from './exceptions/engine.js';
import { RULES } from './exceptions/rules.js';
import { describeProvider, getProvider, PROVIDERS, recordsToCsv } from './connectors/index.js';
import { canStoreCredentials, decryptCredentials, encryptCredentials } from './connectors/secrets.js';
import { assetsCsv, buildReportRows, reportTypes, rowsToCsv } from './reports.js';
import { createImportPolicy } from '../../src/import/import-policy.js';
import { isWarrantyExpiringWithinDays } from '../../src/utils/asset-model-label.js';
import {
  PLANS,
  annotateImportOverage,
  assertWithinPlan,
  defaultTrialEndsAt,
  listPublicPlans,
  normalizeBillingRow,
  paymentRequired,
  suspendedBlocksMutation
} from './plans.js';

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
  throw new Error('SAAS_PUBLIC_URL is required in production so invitation links are not built from Host headers.');
}
// An unparseable limit must fall back to the default, not to NaN, because every
// size comparison against NaN is false and would disable the limit entirely.
const maxUploadMb = Number(process.env.SAAS_MAX_UPLOAD_MB);
const maxUploadBytes = (Number.isFinite(maxUploadMb) && maxUploadMb > 0 ? maxUploadMb : 10) * 1024 * 1024;
// Render puts exactly one proxy in front of us; it appends the peer address to
// any client-supplied X-Forwarded-For, so only the trailing entries are trusted.
const trustedProxies = Math.max(0, Number(process.env.SAAS_TRUSTED_PROXIES) || 0);
const SESSION_COOKIE = 'saas_session';
const SESSION_TTL_SEC = 60 * 60 * 12;

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
    await enforceRateLimit(req, 'ready', 60, 60_000);
    return sendJson(res, await readiness());
  }

  if (method === 'GET' && path === '/api/plans') {
    return sendJson(res, { plans: listPublicPlans(), metric: 'managed_devices' });
  }

  if (method === 'POST' && path === '/api/auth/register') {
    if (!allowRegistration) {
      const error = new Error('Self-service registration is disabled. Ask for an invitation.');
      error.status = 403;
      throw error;
    }
    await enforceRateLimit(req, 'auth', 20, 15 * 60_000);
    const input = await readJson(req);
    if (registrationToken && !matchesSecret(input.registrationToken, registrationToken)) {
      const error = new Error('A valid registration token is required.');
      error.status = 403;
      throw error;
    }
    return sendAuthJson(req, res, await register(input), 201);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    await enforceRateLimit(req, 'auth', 20, 15 * 60_000);
    return sendAuthJson(req, res, await login(await readJson(req)));
  }

  if (method === 'POST' && path === '/api/invitations/accept') {
    await enforceRateLimit(req, 'auth', 20, 15 * 60_000);
    return sendAuthJson(req, res, await acceptInvitation(await readJson(req)));
  }

  if (method === 'POST' && path === '/api/auth/logout') {
    // Best-effort revoke: bump epoch so stolen Bearer copies die immediately.
    try {
      const session = await requireSession(req);
      await db.run(
        'UPDATE users SET token_epoch = COALESCE(token_epoch, 0) + 1 WHERE id = ?',
        [session.userId]
      );
    } catch {
      // Still clear the cookie even if the session was already invalid.
    }
    clearSessionCookie(req, res);
    return sendJson(res, { ok: true });
  }

  const session = await requireSession(req);
  await enforceBillingAccess(req, session);

  if (method === 'GET' && path === '/api/me') {
    return sendJson(res, await getMe(session));
  }

  if (method === 'GET' && path === '/api/billing') {
    return sendJson(res, await getBilling(session.organizationId));
  }

  if (method === 'POST' && path === '/api/auth/switch-organization') {
    return sendAuthJson(req, res, await switchOrganization(session, await readJson(req)));
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
    return sendAuthJson(req, res, await changePassword(session, await readJson(req)));
  }

  if (method === 'DELETE' && path === '/api/organizations/current') {
    requireRole(session, ['admin']);
    return sendJson(res, await deleteCurrentOrganization(session, await readJson(req)));
  }

  if (path === '/api/audit' && method === 'GET') {
    requireRole(session, ['admin', 'it']);
    return sendJson(res, await listAuditLogs(session.organizationId));
  }

  if (path === '/api/settings') {
    if (method === 'GET') {
      requireRole(session, ['admin', 'it']);
      return sendJson(res, await getOrganizationSettings(session.organizationId));
    }
    if (method === 'PUT') {
      requireRole(session, ['admin']);
      const settings = await updateOrganizationSettings(session, await readJson(req));
      return sendJson(res, settings);
    }
  }

  if (method === 'GET' && path === '/api/dashboard') {
    return sendJson(res, await getDashboard(session.organizationId));
  }

  if (path === '/api/catalog' && method === 'GET') {
    return sendJson(res, await listCatalog(db, session.organizationId));
  }

  if (path === '/api/catalog/models' && method === 'POST') {
    requireRole(session, ['admin', 'it']);
    const model = await createCatalogModel(db, session.organizationId, await readJson(req));
    await addAudit(session, 'catalog.model_create', 'catalog_model', model.id, { name: model.name });
    return sendJson(res, model, 201);
  }

  if (path === '/api/catalog/categories' && method === 'POST') {
    requireRole(session, ['admin']);
    const category = await createCategory(db, session.organizationId, await readJson(req));
    await addAudit(session, 'catalog.category_create', 'catalog_category', category.id, { name: category.name });
    return sendJson(res, category, 201);
  }

  if (method === 'PATCH' && path.startsWith('/api/catalog/categories/')) {
    requireRole(session, ['admin']);
    const id = path.split('/')[4];
    const category = await updateCategory(db, session.organizationId, id, await readJson(req));
    await addAudit(session, 'catalog.category_update', 'catalog_category', id);
    return sendJson(res, category);
  }

  if (method === 'DELETE' && path.startsWith('/api/catalog/categories/')) {
    requireRole(session, ['admin']);
    const id = path.split('/')[4];
    const result = await deleteCategory(db, session.organizationId, id);
    await addAudit(session, 'catalog.category_delete', 'catalog_category', id, result);
    return sendJson(res, result);
  }

  if (path === '/api/catalog/brands' && method === 'POST') {
    requireRole(session, ['admin']);
    const brand = await createBrand(db, session.organizationId, await readJson(req));
    await addAudit(session, 'catalog.brand_create', 'catalog_brand', brand.id, { name: brand.name });
    return sendJson(res, brand, 201);
  }

  if (method === 'PATCH' && path.startsWith('/api/catalog/brands/')) {
    requireRole(session, ['admin']);
    const id = path.split('/')[4];
    const brand = await updateBrand(db, session.organizationId, id, await readJson(req));
    await addAudit(session, 'catalog.brand_update', 'catalog_brand', id);
    return sendJson(res, brand);
  }

  if (method === 'DELETE' && path.startsWith('/api/catalog/brands/')) {
    requireRole(session, ['admin']);
    const id = path.split('/')[4];
    const result = await deleteBrand(db, session.organizationId, id);
    await addAudit(session, 'catalog.brand_delete', 'catalog_brand', id, result);
    return sendJson(res, result);
  }

  if (method === 'PATCH' && path.startsWith('/api/catalog/models/')) {
    requireRole(session, ['admin']);
    const id = path.split('/')[4];
    const model = await updateModel(db, session.organizationId, id, await readJson(req));
    await addAudit(session, 'catalog.model_update', 'catalog_model', id);
    return sendJson(res, model);
  }

  if (method === 'DELETE' && path.startsWith('/api/catalog/models/')) {
    requireRole(session, ['admin']);
    const id = path.split('/')[4];
    const result = await deleteModel(db, session.organizationId, id);
    await addAudit(session, 'catalog.model_delete', 'catalog_model', id, result);
    return sendJson(res, result);
  }

  if (path === '/api/catalog/reset-defaults' && method === 'POST') {
    requireRole(session, ['admin']);
    const result = await resetDefaults(db, session.organizationId);
    await addAudit(session, 'catalog.reset_defaults', 'catalog', session.organizationId, result.added);
    return sendJson(res, result);
  }

  if (path === '/api/options' && method === 'GET') {
    return sendJson(res, await listAllOptions(db, session.organizationId));
  }

  if (method === 'POST' && path.startsWith('/api/options/')) {
    requireRole(session, ['admin']);
    const kind = path.split('/')[3];
    const option = await createOption(db, session.organizationId, kind, await readJson(req));
    await addAudit(session, 'options.create', 'org_option', option.id, { kind, key: option.key });
    return sendJson(res, option, 201);
  }

  if (method === 'PATCH' && path.startsWith('/api/options/')) {
    requireRole(session, ['admin']);
    const parts = path.split('/');
    const kind = parts[3];
    const id = parts[4];
    const option = await updateOption(db, session.organizationId, id, await readJson(req));
    await addAudit(session, 'options.update', 'org_option', id, { kind });
    return sendJson(res, option);
  }

  if (method === 'DELETE' && path.startsWith('/api/options/')) {
    requireRole(session, ['admin']);
    const parts = path.split('/');
    const kind = parts[3];
    const id = parts[4];
    const result = await deleteOption(db, session.organizationId, id);
    await addAudit(session, 'options.delete', 'org_option', id, { kind, ...result });
    return sendJson(res, result);
  }

  if (path === '/api/custom-fields' && method === 'GET') {
    const entity = clean(url.searchParams.get('entity') || 'asset') || 'asset';
    return sendJson(res, await listCustomFields(db, session.organizationId, entity));
  }

  if (path === '/api/custom-fields' && method === 'POST') {
    requireRole(session, ['admin']);
    const body = await readJson(req);
    const field = await createCustomField(
      db,
      session.organizationId,
      clean(body.entity) || 'asset',
      body
    );
    await addAudit(session, 'custom_fields.create', 'custom_field', field.id, {
      entity: field.entity,
      key: field.key
    });
    return sendJson(res, field, 201);
  }

  if (method === 'PATCH' && path.startsWith('/api/custom-fields/')) {
    requireRole(session, ['admin']);
    const id = path.split('/')[3];
    const field = await updateCustomField(db, session.organizationId, id, await readJson(req));
    await addAudit(session, 'custom_fields.update', 'custom_field', id);
    return sendJson(res, field);
  }

  if (method === 'DELETE' && path.startsWith('/api/custom-fields/')) {
    requireRole(session, ['admin']);
    const id = path.split('/')[3];
    const result = await deleteCustomField(db, session.organizationId, id);
    await addAudit(session, 'custom_fields.delete', 'custom_field', id, result);
    return sendJson(res, result);
  }

  if (path === '/api/import/presets' && method === 'GET') {
    const kind = clean(url.searchParams.get('kind'));
    return sendJson(res, listPresets(kind || undefined));
  }

  if (path === '/api/import/profiles' && method === 'GET') {
    return sendJson(res, await listImportProfiles(db, session.organizationId));
  }

  if (path === '/api/import/profiles' && method === 'POST') {
    requireRole(session, ['admin', 'it']);
    const profile = await createImportProfile(db, session.organizationId, await readJson(req));
    await addAudit(session, 'import.profile_create', 'import_profile', profile.id, {
      name: profile.name,
      presetKey: profile.presetKey
    });
    return sendJson(res, profile, 201);
  }

  if (method === 'PATCH' && path.startsWith('/api/import/profiles/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[4];
    const profile = await updateImportProfile(db, session.organizationId, id, await readJson(req));
    await addAudit(session, 'import.profile_update', 'import_profile', id);
    return sendJson(res, profile);
  }

  if (method === 'DELETE' && path.startsWith('/api/import/profiles/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[4];
    const result = await deleteImportProfile(db, session.organizationId, id);
    await addAudit(session, 'import.profile_delete', 'import_profile', id, result);
    return sendJson(res, result);
  }

  if (method === 'GET' && path === '/api/connections') {
    return sendJson(res, await listConnections(session.organizationId));
  }

  if (method === 'PUT' && /^\/api\/connections\/[^/]+$/.test(path)) {
    requireRole(session, ['admin']);
    const connection = await saveConnection(session, path.split('/')[3], await readJson(req));
    return sendJson(res, connection);
  }

  if (method === 'DELETE' && /^\/api\/connections\/[^/]+$/.test(path)) {
    requireRole(session, ['admin']);
    const provider = path.split('/')[3];
    await db.run('DELETE FROM connections WHERE organization_id = ? AND provider = ?', [session.organizationId, provider]);
    await addAudit(session, 'connection.delete', 'connection', provider);
    return sendJson(res, { ok: true, provider });
  }

  if (method === 'POST' && /^\/api\/connections\/[^/]+\/sync$/.test(path)) {
    requireRole(session, ['admin', 'it']);
    await enforceRateLimit(req, 'connector-sync', 20, 60 * 60_000);
    return sendJson(res, await syncConnection(session, path.split('/')[3]));
  }

  if (method === 'GET' && path === '/api/exceptions') {
    return sendJson(res, await listExceptions(db, session.organizationId, {
      status: url.searchParams.get('status') ?? 'active',
      rule: url.searchParams.get('rule'),
      severity: url.searchParams.get('severity'),
      assignee: url.searchParams.get('assignee'),
      entityType: url.searchParams.get('entityType'),
      entityId: url.searchParams.get('entityId')
    }));
  }

  if (method === 'GET' && path === '/api/exceptions/summary') {
    return sendJson(res, await summarizeExceptions(db, session.organizationId));
  }

  if (method === 'GET' && path === '/api/exceptions/rules') {
    return sendJson(res, {
      rules: RULES.map(({ key, label, severity, entityType, suggestion }) => ({
        key, label, severity, entityType, suggestion
      })),
      settings: await loadRuleSettings(db, session.organizationId)
    });
  }

  if (method === 'PUT' && path === '/api/exceptions/rules') {
    requireRole(session, ['admin']);
    const settings = await saveRuleSettings(db, session.organizationId, await readJson(req));
    await addAudit(session, 'exceptions.rules_update', 'organization', session.organizationId, settings);
    const scan = await runExceptionScan(db, session.organizationId, { userId: session.userId });
    return sendJson(res, { settings, scan });
  }

  if (method === 'POST' && path === '/api/exceptions/scan') {
    requireRole(session, ['admin', 'it']);
    const scan = await runExceptionScan(db, session.organizationId, { userId: session.userId });
    await addAudit(session, 'exceptions.scan', 'organization', session.organizationId, scan);
    return sendJson(res, scan);
  }

  if (method === 'GET' && path.startsWith('/api/exceptions/')) {
    const exception = await getException(db, session.organizationId, path.split('/')[3]);
    if (!exception) throw notFound('Exception not found');
    return sendJson(res, exception);
  }

  if (method === 'PATCH' && path.startsWith('/api/exceptions/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[3];
    const body = await readJson(req);
    const exception = await updateException(db, session.organizationId, id, body, session.userId);
    await addAudit(session, `exception.${clean(body.action)}`, 'exception', id, {
      ruleKey: exception.ruleKey,
      note: clean(body.note) || undefined
    });
    return sendJson(res, exception);
  }

  if (method === 'GET' && /^\/api\/people\/[^/]+\/overview$/.test(path)) {
    return sendJson(res, await getPersonOverview(session.organizationId, path.split('/')[3]));
  }

  if (method === 'GET' && path === '/api/reports') {
    return sendJson(res, reportTypes);
  }

  if (method === 'GET' && path.startsWith('/api/reports/')) {
    const reportId = path.split('/')[3];
    const [assets, people, statusOptions] = await Promise.all([
      listAssets(session.organizationId),
      listPeople(session.organizationId),
      listOptions(db, session.organizationId, 'status')
    ]);
    const rows = buildReportRows(reportId, { assets, people, statusOptions });
    return sendCsv(res, rowsToCsv(rows), `report-${reportId}.csv`);
  }

  if (method === 'GET' && path === '/api/export/assets') {
    return sendCsv(res, assetsCsv(await listAssets(session.organizationId)), 'devices.csv');
  }

  if (method === 'POST' && path === '/api/import/preview') {
    requireRole(session, ['admin', 'it']);
    await enforceRateLimit(req, 'upload', 30, 60 * 60_000);
    const upload = await readMultipartForm(req, maxUploadBytes);
    requireImportFile(upload);
    const preview = await createImportPreview(session, upload);
    return sendJson(res, preview, 201);
  }

  if (method === 'POST' && path === '/api/import/apply') {
    requireRole(session, ['admin', 'it']);
    const result = await applyImportBatch(session, await readJson(req));
    return sendJson(res, { ...result, exceptions: await refreshExceptions(session) });
  }

  if (method === 'POST' && path === '/api/import/users/preview') {
    requireRole(session, ['admin', 'it']);
    await enforceRateLimit(req, 'upload', 30, 60 * 60_000);
    const upload = await readMultipartForm(req, maxUploadBytes);
    requireImportFile(upload);
    return sendJson(res, await createUserImportPreview(session, upload), 201);
  }

  if (method === 'POST' && path === '/api/import/users/apply') {
    requireRole(session, ['admin', 'it']);
    const result = await applyUserImportBatch(session, await readJson(req));
    return sendJson(res, { ...result, exceptions: await refreshExceptions(session) });
  }

  if (method === 'POST' && path === '/api/people/merge') {
    requireRole(session, ['admin', 'it']);
    const body = await readJson(req);
    const result = await mergePeople(session.organizationId, body);
    await refreshExceptions(session);
    await addAudit(session, 'person.merge', 'person', result.person?.id || '', {
      absorbedId: result.absorbedId,
      movedAssets: result.movedAssets
    });
    return sendJson(res, result);
  }

  if (path === '/api/people') {
    if (method === 'GET') return sendJson(res, await listPeople(session.organizationId));
    if (method === 'POST') {
      requireRole(session, ['admin', 'it']);
      const person = await createPerson(session.organizationId, await readJson(req));
      await addAudit(session, 'person.create', 'person', person.id);
    await refreshExceptions(session);
      return sendJson(res, person, 201);
    }
  }

  if (method === 'PUT' && path.startsWith('/api/people/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[3];
    const person = await updatePerson(session.organizationId, id, await readJson(req));
    await addAudit(session, 'person.update', 'person', id);
    await refreshExceptions(session);
    return sendJson(res, person);
  }

  if (method === 'DELETE' && path.startsWith('/api/people/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[3];
    await deletePerson(session.organizationId, id);
    await addAudit(session, 'person.delete', 'person', id);
    await refreshExceptions(session);
    return sendJson(res, { ok: true, id });
  }

  if (path === '/api/assets') {
    if (method === 'GET') return sendJson(res, await listAssets(session.organizationId));
    if (method === 'POST') {
      requireRole(session, ['admin', 'it']);
      const asset = await createAsset(session.organizationId, await readJson(req));
      await addAudit(session, 'asset.create', 'asset', asset.id);
      await refreshExceptions(session);
      return sendJson(res, asset, 201);
    }
  }

  if (method === 'GET' && path.startsWith('/api/assets/')) {
    return sendJson(res, await getAssetDetail(session.organizationId, path.split('/')[3]));
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
    await refreshExceptions(session);
    return sendJson(res, asset);
  }

  if (method === 'DELETE' && path.startsWith('/api/assets/')) {
    requireRole(session, ['admin', 'it']);
    const id = path.split('/')[3];
    await deleteAsset(session.organizationId, id);
    await addAudit(session, 'asset.delete', 'asset', id);
    await refreshExceptions(session);
    return sendJson(res, { ok: true, id });
  }

  throw notFound('API route not found');
}

async function requireSession(req) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const cookieToken = readCookie(req, SESSION_COOKIE);
  const token = bearer || cookieToken;
  const authSource = bearer ? 'bearer' : (cookieToken ? 'cookie' : '');
  const payload = verifyToken(token);
  if (!payload?.sub || !payload?.org) throw unauthorized();
  assertSameOriginMutation(req, authSource);
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
    role: membership.role,
    authSource
  };
}

/**
 * Suspended orgs stay readable (including CSV export). Mutations return 402 so
 * the client can show billing copy instead of a generic auth failure.
 */
async function enforceBillingAccess(req, session) {
  if (!suspendedBlocksMutation(req.method)) return;
  const billing = await loadOrganizationBilling(session.organizationId);
  if (billing.status !== 'suspended') return;
  throw paymentRequired('Organization billing is suspended. Export and read-only access remain available.', {
    plan: billing.plan,
    status: billing.status,
    deviceUsage: billing.deviceUsage,
    deviceLimit: billing.deviceLimit
  });
}

function sendAuthJson(req, res, payload, status = 200) {
  if (payload?.token) setSessionCookie(req, res, payload.token);
  return sendJson(res, payload, status);
}

function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SEC}`
  ];
  if (requestIsHttps(req) || publicUrl.startsWith('https://')) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];
  if (requestIsHttps(req) || publicUrl.startsWith('https://')) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return '';
}

function requestIsHttps(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwardedProto === 'https';
}

/**
 * Cookie sessions are auto-attached by the browser, so state-changing requests
 * that authenticate via cookie must come from this origin. Bearer tokens are
 * not auto-sent cross-site, so they skip this check (API/scripts/tests).
 */
function assertSameOriginMutation(req, authSource) {
  if (authSource !== 'cookie') return;
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) throw unauthorized('Cross-origin request blocked');
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw unauthorized('Cross-origin request blocked');
    }
    if (originHost !== host) throw unauthorized('Cross-origin request blocked');
    return;
  }
  const referer = String(req.headers.referer || '').trim();
  if (referer) {
    let refererHost = '';
    try {
      refererHost = new URL(referer).host.toLowerCase();
    } catch {
      throw unauthorized('Cross-origin request blocked');
    }
    if (refererHost !== host) throw unauthorized('Cross-origin request blocked');
  }
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

  const trialEndsAt = defaultTrialEndsAt(new Date(now));
  const trialLimit = PLANS.trial.deviceLimit;

  await db.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO organizations (
        id, name, slug, created_at, plan, status, device_limit, trial_ends_at, billing_email
      ) VALUES (?, ?, ?, ?, 'trial', 'trial', ?, ?, ?)
    `, [orgId, orgName, slug, now, trialLimit, trialEndsAt, email]);

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

  const token = signToken({
    sub: userId,
    org: orgId,
    role: 'admin',
    email,
    epoch: 0
  }, SESSION_TTL_SEC);
  return {
    token,
    user: { id: userId, email, name },
    organization: { id: orgId, name: orgName, plan: 'trial', status: 'trial', deviceLimit: trialLimit, trialEndsAt }
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
  }, SESSION_TTL_SEC);
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
  const billing = await getBilling(session.organizationId);
  return {
    user,
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: billing.plan,
      status: billing.status,
      deviceLimit: billing.deviceLimit,
      trialEndsAt: billing.trialEndsAt
    },
    organizations: await listUserOrganizations(session.userId),
    role: session.role,
    billing
  };
}

async function loadOrganizationBilling(organizationId) {
  const row = await db.get(`
    SELECT plan, status, device_limit, trial_ends_at, billing_email
    FROM organizations
    WHERE id = ?
  `, [organizationId]);
  if (!row) throw notFound('Organization not found');
  const billing = normalizeBillingRow(row);
  const deviceUsage = await countManagedDevices(organizationId);
  return { ...billing, deviceUsage };
}

async function getBilling(organizationId) {
  const billing = await loadOrganizationBilling(organizationId);
  return {
    ...billing,
    plans: listPublicPlans(),
    metric: 'managed_devices',
    metricLabel: 'Managed (non-retired) devices'
  };
}

async function countManagedDevices(organizationId) {
  const row = await db.get(`
    SELECT COUNT(*) AS count
    FROM assets
    WHERE organization_id = ?
      AND LOWER(COALESCE(status, '')) <> 'retired'
  `, [organizationId]);
  return Number(row?.count || 0);
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
    }, SESSION_TTL_SEC),
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
    // Fragment keeps the bearer invite token out of access logs and Referer history.
    inviteUrl: `${inviteBaseUrl(req)}/#invite=${encodeURIComponent(token)}`
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
    }, SESSION_TTL_SEC),
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
  await db.run(
    'UPDATE memberships SET role = ? WHERE id = ? AND organization_id = ?',
    [role, membership.id, session.organizationId]
  );
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
    await tx.run(
      'DELETE FROM memberships WHERE id = ? AND organization_id = ?',
      [membership.id, session.organizationId]
    );
    await deleteUserWithoutOrganizations(tx, userId);
  });
  await addAudit(session, 'member.remove', 'user', userId, {
    role: membership.role,
    emailDomain: domainOf(removed?.email || '')
  });
  return { ok: true, id: userId };
}

function domainOf(email) {
  const at = String(email).lastIndexOf('@');
  return at >= 0 ? String(email).slice(at + 1).toLowerCase() : '';
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
    }, SESSION_TTL_SEC)
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
  return (await db.all(`
    SELECT id, first_name AS "firstName", last_name AS "lastName", email, department,
           role_title AS role, status, external_ids_json AS "externalIdsJson",
           custom_json AS "customJson", source_presence_json AS "sourcePresenceJson",
           manager_email AS "manager", last_synced_at AS "lastSyncedAt",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM people
    WHERE organization_id = ?
    ORDER BY LOWER(last_name), LOWER(first_name)
  `, [organizationId])).map((row) => ({
    ...row,
    externalIds: normalizePersonExternalIds(parseJson(row.externalIdsJson, {})),
    custom: parseJson(row.customJson, {}),
    sourcePresence: parseJson(row.sourcePresenceJson, {}),
    externalIdsJson: undefined,
    customJson: undefined,
    sourcePresenceJson: undefined
  }));
}

// Identity columns an MDM export can carry for one person. Alternate addresses
// keep a renamed employee from being imported twice.
function normalizePersonExternalIds(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  return {
    upn: clean(value.upn).toLowerCase(),
    jamfUsername: clean(value.jamfUsername),
    entraObjectId: clean(value.entraObjectId),
    alternateEmails: [...new Set(
      (Array.isArray(value.alternateEmails) ? value.alternateEmails : [])
        .map((email) => clean(email).toLowerCase())
        .filter(Boolean)
    )]
  };
}

function normalizeAssetExternalIds(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleaned = clean(raw);
    if (cleaned) result[clean(key)] = cleaned;
  }
  return result;
}

async function createPerson(organizationId, input) {
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  if (!firstName || !lastName) throw badRequest('firstName and lastName are required');
  const department = await resolveDepartmentValue(organizationId, input.department);
  const custom = await resolveCustomValues(organizationId, 'person', input.custom);
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.run(`
    INSERT INTO people (
      id, organization_id, first_name, last_name, email, department, role_title, status,
      external_ids_json, custom_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    organizationId,
    firstName,
    lastName,
    clean(input.email).toLowerCase(),
    department,
    clean(input.role),
    input.status === 'inactive' ? 'inactive' : 'active',
    JSON.stringify(normalizePersonExternalIds(input.externalIds)),
    JSON.stringify(custom),
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

  const externalIds = input.externalIds === undefined
    ? normalizePersonExternalIds(parseJson(existing.external_ids_json, {}))
    : normalizePersonExternalIds({
        ...parseJson(existing.external_ids_json, {}),
        ...input.externalIds
      });
  const department = input.department === undefined
    ? existing.department
    : await resolveDepartmentValue(organizationId, input.department);
  const custom = input.custom === undefined
    ? parseJson(existing.custom_json, {})
    : await resolveCustomValues(organizationId, 'person', input.custom);

  await db.run(`
    UPDATE people
    SET first_name = ?, last_name = ?, email = ?, department = ?, role_title = ?,
        status = ?, external_ids_json = ?, custom_json = ?, updated_at = ?
    WHERE id = ? AND organization_id = ?
  `, [
    firstName,
    lastName,
    pick(input.email, existing.email).toLowerCase(),
    department,
    pick(input.role, existing.role_title),
    status,
    JSON.stringify(externalIds),
    JSON.stringify(custom),
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

/**
 * Imports from two systems routinely create the same employee twice (a UPN in
 * one export, a personal mailbox in the other). Merging keeps one record,
 * moves the devices and assignment history onto it, and files every address
 * the absorbed record carried so a later import matches instead of splitting
 * the person again.
 */
async function mergePeople(organizationId, input) {
  const keepId = clean(input.keepId);
  const absorbId = clean(input.absorbId);
  if (!keepId || !absorbId) throw badRequest('keepId and absorbId are required');
  if (keepId === absorbId) throw badRequest('keepId and absorbId must differ');

  const [keep, absorb] = await Promise.all([
    db.get('SELECT * FROM people WHERE id = ? AND organization_id = ?', [keepId, organizationId]),
    db.get('SELECT * FROM people WHERE id = ? AND organization_id = ?', [absorbId, organizationId])
  ]);
  if (!keep || !absorb) throw notFound('Person not found');

  const keepIds = normalizePersonExternalIds(parseJson(keep.external_ids_json, {}));
  const absorbIds = normalizePersonExternalIds(parseJson(absorb.external_ids_json, {}));
  const merged = normalizePersonExternalIds({
    upn: keepIds.upn || absorbIds.upn,
    jamfUsername: keepIds.jamfUsername || absorbIds.jamfUsername,
    entraObjectId: keepIds.entraObjectId || absorbIds.entraObjectId,
    alternateEmails: [
      ...keepIds.alternateEmails,
      ...absorbIds.alternateEmails,
      absorbIds.upn,
      clean(absorb.email).toLowerCase()
    ].filter((email) => email && email !== clean(keep.email).toLowerCase())
  });

  const now = new Date().toISOString();
  let movedAssets = 0;
  await db.transaction(async (tx) => {
    movedAssets = (await tx.run(
      'UPDATE assets SET person_id = ?, updated_at = ? WHERE person_id = ? AND organization_id = ?',
      [keepId, now, absorbId, organizationId]
    )).changes;
    await tx.run(
      'UPDATE asset_assignments SET person_id = ? WHERE person_id = ? AND organization_id = ?',
      [keepId, absorbId, organizationId]
    );
    await tx.run(`
      UPDATE people
      SET email = ?, department = ?, role_title = ?, external_ids_json = ?, updated_at = ?
      WHERE id = ? AND organization_id = ?
    `, [
      clean(keep.email) || clean(absorb.email),
      clean(keep.department) || clean(absorb.department),
      clean(keep.role_title) || clean(absorb.role_title),
      JSON.stringify(merged),
      now,
      keepId,
      organizationId
    ]);
    await tx.run('DELETE FROM people WHERE id = ? AND organization_id = ?', [absorbId, organizationId]);
  });

  const person = (await listPeople(organizationId)).find((item) => item.id === keepId);
  return { ok: true, person, movedAssets, absorbedId: absorbId };
}

async function getDashboard(organizationId) {
  const [assets, people, statusOptions] = await Promise.all([
    listAssets(organizationId),
    listPeople(organizationId),
    listOptions(db, organizationId, 'status')
  ]);

  const recentAssignments = (await db.all(`
    SELECT s.id, s.started_at AS "startedAt", s.ended_at AS "endedAt", s.end_reason AS "endReason",
           s.source, s.asset_id AS "assetId", s.person_id AS "personId",
           a.asset_tag AS "assetTag", a.serial_number AS "serialNumber", a.model_name AS "modelName",
           p.first_name AS "firstName", p.last_name AS "lastName", p.email
    FROM asset_assignments s
    JOIN assets a ON a.id = s.asset_id AND a.organization_id = s.organization_id
    LEFT JOIN people p ON p.id = s.person_id AND p.organization_id = s.organization_id
    WHERE s.organization_id = ?
    ORDER BY s.started_at DESC, s.id DESC
    LIMIT 10
  `, [organizationId])).map((row) => ({
    id: row.id,
    assetId: row.assetId,
    assetTag: row.assetTag,
    serialNumber: row.serialNumber,
    modelName: row.modelName,
    personId: row.personId,
    personName: [row.firstName, row.lastName].filter(Boolean).join(' ').trim(),
    personEmail: row.email || '',
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    endReason: row.endReason,
    source: row.source
  }));

  const warrantyExpiring30 = assets.filter((asset) => isWarrantyExpiringWithinDays(asset.warrantyEndsOn, 30));
  const warrantyExpiring90 = assets.filter((asset) => isWarrantyExpiringWithinDays(asset.warrantyEndsOn, 90));
  const activePeople = people.filter((person) => person.status !== 'inactive');

  return {
    counts: {
      assets: assets.length,
      people: people.length,
      assignedAssets: assets.filter((asset) => asset.personId).length,
      peopleWithoutDevice: activePeople.filter(
        (person) => !assets.some((asset) => asset.personId === person.id)
      ).length,
      missingFromMdm: assets.filter((asset) => asset.importMeta?.missingFromLastImport).length
    },
    assets: {
      byStatus: countBy(assets, (asset) => countsAs(asset.status, statusOptions)),
      byCategory: countBy(assets, (asset) => asset.category || 'Uncategorized'),
      byModel: countBy(assets, (asset) => asset.modelName || 'Unknown')
    },
    people: {
      total: people.length,
      active: activePeople.length,
      inactive: people.length - activePeople.length,
      byDepartment: countBy(people, (person) => person.department || 'No department'),
      byStatus: countBy(people, (person) => person.status || 'active')
    },
    warranty: {
      expiring30: warrantyExpiring30.length,
      expiring90: warrantyExpiring90.length,
      soonest: warrantyExpiring90
        .slice()
        .sort((a, b) => String(a.warrantyEndsOn).localeCompare(String(b.warrantyEndsOn)))
        .slice(0, 10)
        .map((asset) => ({
          id: asset.id,
          assetTag: asset.assetTag,
          serialNumber: asset.serialNumber,
          modelName: asset.modelName,
          warrantyEndsOn: asset.warrantyEndsOn
        }))
    },
    recentAssignments
  };
}

function countBy(items, getLabel) {
  const counts = new Map();
  for (const item of items) {
    const label = clean(getLabel(item)) || 'Unknown';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

const assetColumns = `
  a.id, a.asset_tag AS "assetTag", a.serial_number AS "serialNumber", a.model_name AS "modelName",
  a.model_id AS "modelId", a.category, a.brand, a.ram_gb AS "ramGb", a.storage_gb AS "storageGb",
  a.cpu, a.imei, a.operating_system AS "operatingSystem", a.warranty_ends_on AS "warrantyEndsOn",
  a.purchased_on AS "purchasedOn", a.vendor, a.notes, a.enrolled_at AS "enrolledAt",
  a.last_enrolled_at AS "lastEnrolledAt", a.status, a.person_id AS "personId",
  a.location_key AS "locationKey", a.custom_json AS "customJson",
  a.last_seen_at AS "lastSeenAt", a.source_presence_json AS "sourcePresenceJson",
  a.external_ids_json AS "externalIdsJson", a.import_meta_json AS "importMetaJson",
  a.created_at AS "createdAt", a.updated_at AS "updatedAt",
  p.first_name AS "personFirstName", p.last_name AS "personLastName",
  p.email AS "personEmail", p.department AS "personDepartment"
`;

async function listAssets(organizationId) {
  const rows = await db.all(`
    SELECT ${assetColumns}
    FROM assets a
    LEFT JOIN people p ON p.id = a.person_id AND p.organization_id = a.organization_id
    WHERE a.organization_id = ?
    ORDER BY LOWER(a.asset_tag)
  `, [organizationId]);
  return rows.map(presentAsset);
}

function presentAsset(row) {
  return {
    ...row,
    externalIds: parseJson(row.externalIdsJson, {}),
    importMeta: parseJson(row.importMetaJson, {}),
    custom: parseJson(row.customJson, {}),
    sourcePresence: parseJson(row.sourcePresenceJson, {}),
    externalIdsJson: undefined,
    importMetaJson: undefined,
    customJson: undefined,
    sourcePresenceJson: undefined
  };
}

/**
 * One place to answer "what does this person have": their devices with
 * presence per source, plus open exceptions on the person or those devices.
 */
async function getPersonOverview(organizationId, personId) {
  const person = (await listPeople(organizationId)).find((item) => item.id === personId);
  if (!person) throw notFound('Person not found');
  const assets = (await listAssets(organizationId)).filter((asset) => asset.personId === personId);
  const active = await listExceptions(db, organizationId, { status: 'active' });
  const assetIds = new Set(assets.map((asset) => asset.id));
  const exceptions = active.filter((item) =>
    (item.entityType === 'person' && item.entityId === personId)
    || (item.entityType === 'asset' && assetIds.has(item.entityId))
    || item.details?.person?.id === personId
  );
  return { person, assets, exceptions };
}

async function listConnections(organizationId) {
  const rows = await db.all(`
    SELECT provider, status, scopes_json AS "scopesJson", config_json AS "configJson",
           encrypted_credentials IS NOT NULL AS "hasCredentials",
           last_sync_at AS "lastSyncAt", last_error AS "lastError", updated_at AS "updatedAt"
    FROM connections WHERE organization_id = ?
  `, [organizationId]);
  return {
    canStoreCredentials: canStoreCredentials(),
    providers: PROVIDERS.map((provider) => {
      const row = rows.find((item) => item.provider === provider.key);
      return {
        ...describeProvider(provider),
        connection: row
          ? {
              status: row.status,
              scopes: parseJson(row.scopesJson, []),
              config: parseJson(row.configJson, {}),
              hasCredentials: Boolean(Number(row.hasCredentials) || row.hasCredentials === true),
              lastSyncAt: row.lastSyncAt,
              lastError: row.lastError,
              updatedAt: row.updatedAt
            }
          : null
      };
    })
  };
}

async function saveConnection(session, providerKey, input) {
  const provider = getProvider(providerKey);
  if (!provider) throw notFound('Unknown connector');
  const now = new Date().toISOString();
  const config = input.config && typeof input.config === 'object' ? input.config : {};
  const credentials = input.credentials && typeof input.credentials === 'object' ? input.credentials : null;
  if (credentials) {
    const unknown = Object.keys(credentials).filter((field) => !provider.credentialFields.includes(field));
    if (unknown.length) throw badRequest(`Unknown credential fields: ${unknown.join(', ')}`);
  }
  const existing = await db.get(
    'SELECT id, encrypted_credentials AS "encrypted" FROM connections WHERE organization_id = ? AND provider = ?',
    [session.organizationId, provider.key]
  );
  let encrypted = null;
  if (credentials) {
    const previous = existing?.encrypted ? decryptCredentials(existing.encrypted) : {};
    const merged = { ...previous };
    for (const [field, value] of Object.entries(credentials)) {
      const trimmed = String(value ?? '').trim();
      if (trimmed) merged[field] = trimmed;
    }
    const optional = new Set(provider.optionalCredentialFields || []);
    const missing = provider.credentialFields.filter((field) =>
      !optional.has(field) && !String(merged[field] || '').trim()
    );
    if (missing.length) throw badRequest(`Missing credential fields: ${missing.join(', ')}`);
    encrypted = encryptCredentials(merged);
  }
  const status = provider.live ? (encrypted || existing?.encrypted ? 'configured' : 'pending') : 'connected';
  if (existing) {
    await db.run(`
      UPDATE connections
      SET status = ?, scopes_json = ?, config_json = ?, encrypted_credentials = ?, updated_at = ?
      WHERE id = ? AND organization_id = ?
    `, [
      status === 'pending' && existing.encrypted ? 'configured' : status,
      JSON.stringify(provider.requiredScopes),
      JSON.stringify(config),
      encrypted || existing.encrypted || null,
      now,
      existing.id,
      session.organizationId
    ]);
  } else {
    await db.run(`
      INSERT INTO connections (
        id, organization_id, provider, status, scopes_json, config_json, encrypted_credentials, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      randomUUID(), session.organizationId, provider.key, status,
      JSON.stringify(provider.requiredScopes), JSON.stringify(config), encrypted, now, now
    ]);
  }
  await addAudit(session, 'connection.save', 'connection', provider.key, {
    status, credentialsUpdated: Boolean(encrypted)
  });
  return (await listConnections(session.organizationId)).providers.find((item) => item.key === provider.key);
}

/**
 * Pulls one provider and pushes its records through the ordinary import
 * preview and apply, so a sync and a CSV upload can never disagree about
 * matching, assignments or the missing-from-MDM flag.
 */
async function syncConnection(session, providerKey) {
  const provider = getProvider(providerKey);
  if (!provider) throw notFound('Unknown connector');
  const row = await db.get(
    'SELECT id, config_json AS "configJson", encrypted_credentials AS "encrypted" FROM connections WHERE organization_id = ? AND provider = ?',
    [session.organizationId, provider.key]
  );
  if (!row) throw badRequest('Connect this provider before syncing');
  const now = new Date().toISOString();
  try {
    const data = await provider.fetch({
      config: parseJson(row.configJson, {}),
      credentials: row.encrypted ? decryptCredentials(row.encrypted) : {}
    });
    const result = { provider: provider.key };
    if (data.users?.records?.length) {
      const preview = await createUserImportPreview(session, syntheticUpload(provider.key, 'users', data.users));
      if (preview.needsMapping) throw badRequest('Connector users could not be mapped');
      result.users = (await applyUserImportBatch(session, { batchId: preview.batchId })).summary;
    }
    if (data.devices?.records?.length) {
      const preview = await createImportPreview(session, syntheticUpload(provider.key, 'devices', data.devices));
      if (preview.needsMapping) throw badRequest('Connector devices could not be mapped');
      result.devices = {
        ...(await applyImportBatch(session, { batchId: preview.batchId })).summary,
        needsReview: preview.summary.needsReview
      };
    }
    await db.run(
      `UPDATE connections
       SET status = 'connected', last_sync_at = ?, last_error = NULL, updated_at = ?
       WHERE id = ? AND organization_id = ?`,
      [now, now, row.id, session.organizationId]
    );
    result.exceptions = await refreshExceptions(session);
    await addAudit(session, 'connection.sync', 'connection', provider.key, {
      users: result.users, devices: result.devices
    });
    return result;
  } catch (error) {
    await db.run(
      `UPDATE connections
       SET status = 'error', last_error = ?, updated_at = ?
       WHERE id = ? AND organization_id = ?`,
      [String(error.message || error).slice(0, 500), now, row.id, session.organizationId]
    );
    throw error;
  }
}

function syntheticUpload(providerKey, kind, dataset) {
  return {
    file: { buffer: recordsToCsv(dataset.records), originalName: `${providerKey}-${kind}.csv` },
    fields: { source: dataset.source }
  };
}

// Exceptions are derived data. A failed rescan must not fail the mutation that
// triggered it; the next scan or import catches up.
async function refreshExceptions(session) {
  try {
    return await runExceptionScan(db, session.organizationId, { userId: session.userId });
  } catch (error) {
    console.error('exception scan failed', error);
    return null;
  }
}

/** Asset detail with its person, full assignment history and import provenance. */
async function getAssetDetail(organizationId, id) {
  const row = await db.get(`
    SELECT ${assetColumns}
    FROM assets a
    LEFT JOIN people p ON p.id = a.person_id AND p.organization_id = a.organization_id
    WHERE a.organization_id = ? AND a.id = ?
  `, [organizationId, id]);
  if (!row) throw notFound('Asset not found');

  const assignments = await db.all(`
    SELECT s.id, s.person_id AS "personId", s.started_at AS "startedAt", s.ended_at AS "endedAt",
           s.end_reason AS "endReason", s.source,
           p.first_name AS "firstName", p.last_name AS "lastName", p.email
    FROM asset_assignments s
    LEFT JOIN people p ON p.id = s.person_id AND p.organization_id = s.organization_id
    WHERE s.asset_id = ? AND s.organization_id = ?
    ORDER BY s.started_at DESC, s.id DESC
  `, [id, organizationId]);

  const asset = presentAsset(row);
  const history = assignments.map((item) => ({
    id: item.id,
    personId: item.personId,
    person: item.personId
      ? { id: item.personId, firstName: item.firstName, lastName: item.lastName, email: item.email }
      : null,
    startedAt: item.startedAt,
    endedAt: item.endedAt,
    endReason: item.endReason,
    source: item.source
  }));
  return {
    ...asset,
    person: row.personId
      ? {
          id: row.personId,
          firstName: row.personFirstName,
          lastName: row.personLastName,
          email: row.personEmail,
          department: row.personDepartment
        }
      : null,
    model: row.modelId ? await db.get(
      'SELECT id, name FROM catalog_models WHERE id = ? AND organization_id = ?',
      [row.modelId, organizationId]
    ) : null,
    assignments: history,
    currentAssignment: history.find((item) => !item.endedAt) || null,
    exceptions: await listExceptions(db, organizationId, {
      status: 'active', entityType: 'asset', entityId: id
    })
  };
}

// Rich hardware fields follow the same partial-update contract as the core
// ones: an absent key keeps the stored value, an empty string clears it.
const assetRichFields = [
  ['model_id', 'modelId', clean],
  ['category', 'category', clean],
  ['brand', 'brand', clean],
  ['ram_gb', 'ramGb', numberOrNull],
  ['storage_gb', 'storageGb', numberOrNull],
  ['cpu', 'cpu', clean],
  ['imei', 'imei', clean],
  ['operating_system', 'operatingSystem', clean],
  ['warranty_ends_on', 'warrantyEndsOn', clean],
  ['purchased_on', 'purchasedOn', clean],
  ['vendor', 'vendor', clean],
  ['notes', 'notes', clean],
  ['enrolled_at', 'enrolledAt', clean],
  ['last_enrolled_at', 'lastEnrolledAt', clean],
  ['location_key', 'locationKey', clean]
];

function richAssetValues(input, existing = {}, extras = {}) {
  return assetRichFields.map(([column, field, normalize]) => {
    if (extras[field] !== undefined) return extras[field];
    return input[field] === undefined ? (existing[column] ?? null) : (normalize(input[field]) || null);
  });
}

function numberOrNull(value) {
  const number = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

async function requireOwnModel(organizationId, modelId) {
  if (!modelId) return;
  const model = await db.get(
    'SELECT id FROM catalog_models WHERE id = ? AND organization_id = ?',
    [modelId, organizationId]
  );
  if (!model) throw badRequest('Model does not belong to this organization');
}

async function createAsset(organizationId, input) {
  const assetTag = clean(input.assetTag);
  const serialNumber = clean(input.serialNumber);
  if (!assetTag || !serialNumber) throw badRequest('assetTag and serialNumber are required');
  const billing = await loadOrganizationBilling(organizationId);
  assertWithinPlan(billing, billing.deviceUsage, { adding: 1 });
  const now = new Date().toISOString();
  const id = randomUUID();
  const personId = clean(input.personId) || null;
  if (personId) {
    const person = await db.get(`
      SELECT id FROM people WHERE id = ? AND organization_id = ?
    `, [personId, organizationId]);
    if (!person) throw badRequest('Person does not belong to this organization');
  }
  await requireOwnModel(organizationId, clean(input.modelId));
  const status = personId ? 'assigned' : await resolveAssetStatus(organizationId, input.status);
  const locationKey = await resolveLocationValue(organizationId, input.locationKey);
  const custom = await resolveCustomValues(organizationId, 'asset', input.custom);
  try {
    await db.transaction(async (tx) => {
      await tx.run(`
        INSERT INTO assets (
          id, organization_id, asset_tag, serial_number, model_name, status, person_id,
          external_ids_json, custom_json, created_at, updated_at,
          ${assetRichFields.map(([column]) => column).join(', ')}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${assetRichFields.map(() => '?').join(', ')})
      `, [
        id,
        organizationId,
        assetTag,
        serialNumber,
        clean(input.modelName),
        status,
        personId,
        JSON.stringify(normalizeAssetExternalIds(input.externalIds)),
        JSON.stringify(custom),
        now,
        now,
        ...richAssetValues(input, {}, { locationKey })
      ]);
      if (personId) {
        await openAssignment(tx, organizationId, id, personId, now, 'manual');
      }
    });
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
  else if (input.status !== undefined) status = await resolveAssetStatus(organizationId, input.status);
  else status = existing.person_id ? 'in_stock' : existing.status;

  if (input.modelId !== undefined) await requireOwnModel(organizationId, clean(input.modelId));
  const externalIds = input.externalIds === undefined
    ? parseJson(existing.external_ids_json, {})
    : { ...parseJson(existing.external_ids_json, {}), ...normalizeAssetExternalIds(input.externalIds) };
  const locationKey = input.locationKey === undefined
    ? existing.location_key
    : await resolveLocationValue(organizationId, input.locationKey);
  const custom = input.custom === undefined
    ? parseJson(existing.custom_json, {})
    : await resolveCustomValues(organizationId, 'asset', input.custom);

  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      await tx.run(`
        UPDATE assets
        SET asset_tag = ?, serial_number = ?, model_name = ?, status = ?, person_id = ?,
            external_ids_json = ?, custom_json = ?, updated_at = ?,
            ${assetRichFields.map(([column]) => `${column} = ?`).join(', ')}
        WHERE id = ? AND organization_id = ?
      `, [
        assetTag,
        serialNumber,
        pick(input.modelName, existing.model_name),
        status,
        personId,
        JSON.stringify(externalIds),
        JSON.stringify(custom),
        now,
        ...richAssetValues(input, existing, { locationKey }),
        id,
        organizationId
      ]);
      if ((existing.person_id || null) !== personId) {
        await closeOpenAssignment(tx, organizationId, id, now, personId ? 'reassign' : 'return');
        if (personId) await openAssignment(tx, organizationId, id, personId, now, 'manual');
      }
    });
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
  const [existingAssets, existingPeople, policy, catalog, profiles] = await Promise.all([
    listAssets(session.organizationId),
    listPeople(session.organizationId),
    loadImportPolicy(session.organizationId),
    listCatalog(db, session.organizationId),
    listImportProfiles(db, session.organizationId)
  ]);
  const mapping = parseOptionalJsonField(upload.fields.mapping);
  const preview = buildSaasImportPreview({
    buffer: upload.file.buffer,
    fileName: upload.file.originalName,
    source: upload.fields.source || 'auto',
    existingAssets,
    existingPeople,
    catalog,
    policy,
    mapping,
    profiles,
    profileId: clean(upload.fields.profileId)
  });

  if (preview.needsMapping) {
    return preview;
  }

  const billing = await loadOrganizationBilling(session.organizationId);
  preview.summary = annotateImportOverage(preview.summary, billing, billing.deviceUsage);

  const saveAsProfile = clean(upload.fields.saveAsProfile);
  let profileId = preview.profileId || '';
  if (saveAsProfile && preview.mapping) {
    const profile = await createImportProfile(db, session.organizationId, {
      name: saveAsProfile,
      presetKey: preview.source,
      headerSignature: preview.headerSignature || clean(upload.fields.headerSignature),
      mapping: preview.mapping,
      headers: []
    });
    profileId = profile.id;
    await addAudit(session, 'import.profile_create', 'import_profile', profile.id, {
      name: profile.name,
      fromPreview: true
    });
  }

  const batchId = randomUUID();
  const now = new Date().toISOString();
  const policySnapshot = {
    excludedEmails: [...policy.excludedEmails],
    excludedNameRules: policy.excludedNameRules.map((rule) => ({
      id: rule.id,
      tokens: [...rule.tokens]
    })),
    identityGroups: policy.identityGroups.map((group) => ({
      emails: [...group.emails],
      firstName: group.firstName,
      lastName: group.lastName
    })),
    modelOverrides: { ...policy.modelOverrides }
  };

  await db.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO import_batches (
        id, organization_id, user_id, kind, source, file_name, status, summary_json, policy_json, profile_id, created_at
      ) VALUES (?, ?, ?, 'devices', ?, ?, 'preview', ?, ?, ?, ?)
    `, [
      batchId,
      session.organizationId,
      session.userId,
      preview.source,
      preview.fileName,
      JSON.stringify(preview.summary),
      JSON.stringify(policySnapshot),
      profileId || null,
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
  return { ...preview, batchId, profileId };
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
  const modelOverrides = input.modelOverrides && typeof input.modelOverrides === 'object'
    ? input.modelOverrides
    : {};
  const selected = rows.filter((row) => {
    if (row.action === 'skip') return false;
    if (!includeIds || includeIds.has(row.id)) {
      if (row.action === 'needs_review') {
        const data = parseJson(row.dataJson, {});
        const override = clean(modelOverrides[data.rowKey] || modelOverrides[row.id] || '');
        return Boolean(override);
      }
      return true;
    }
    return false;
  });
  const parsedRows = selected.map((stored) => {
    const row = JSON.parse(stored.dataJson);
    const overrideModelId = clean(modelOverrides[row.rowKey] || modelOverrides[stored.id] || '');
    if (overrideModelId) {
      row.modelId = overrideModelId;
      if (row.action === 'needs_review') {
        row.action = row.matchedAssetId ? 'update' : 'create';
      }
    }
    return { stored, row, overrideModelId };
  });

  for (const { row } of parsedRows) {
    if (clean(row.person?.department)) {
      await ensureDepartmentOption(db, session.organizationId, row.person.department);
    }
    if (clean(row.location)) {
      const locations = await listOptions(db, session.organizationId, 'location');
      const match = locations.find((item) =>
        item.key === clean(row.location)
        || item.label.toLowerCase() === clean(row.location).toLowerCase()
      );
      if (!match) {
        await createOption(db, session.organizationId, 'location', { label: clean(row.location) });
      }
    }
  }

  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  let peopleCreated = 0;
  let missingFromImport = 0;
  const source = batch.source || 'import';
  const touchedAssetIds = new Set();

  await db.transaction(async (tx) => {
    for (const { stored, row, overrideModelId } of parsedRows) {
      if (overrideModelId) {
        const model = await tx.get(
          'SELECT id, name FROM catalog_models WHERE id = ? AND organization_id = ?',
          [overrideModelId, session.organizationId]
        );
        if (model) row.modelName = model.name;
      }
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

      const externalIds = buildExternalIds(source, row.externalId);
      const importMeta = {
        source,
        lastImportedAt: now,
        lastImportFile: batch.file_name || '',
        missingFromLastImport: false
      };
      const existing = await findAssetForImport(tx, session.organizationId, row);

      if (existing) {
        const previousPersonId = existing.person_id || null;
        await tx.run(`
          UPDATE assets
          SET asset_tag = ?, model_name = ?, model_id = COALESCE(?, model_id),
              brand = COALESCE(?, brand), category = COALESCE(?, category),
              status = ?, person_id = ?,
              external_ids_json = ?, import_meta_json = ?, updated_at = ?,
              ${importedAssetFields.map(([column]) => `${column} = COALESCE(?, ${column})`).join(', ')}
          WHERE id = ? AND organization_id = ?
        `, [
          row.assetTag,
          row.modelName,
          clean(row.modelId) || null,
          clean(row.brand) || null,
          clean(row.category) || null,
          personId ? 'assigned' : existing.status,
          personId,
          JSON.stringify(mergeJson(existing.external_ids_json, externalIds)),
          JSON.stringify(importMeta),
          now,
          ...importedAssetValues(row),
          existing.id,
          session.organizationId
        ]);
        touchedAssetIds.add(existing.id);
        await recordAssetPresence(tx, session.organizationId, existing.id, source, row, now);
        if (previousPersonId !== personId) {
          await closeOpenAssignment(tx, session.organizationId, existing.id, now, `Import ${source}`);
          if (personId) {
            await openAssignment(tx, session.organizationId, existing.id, personId, now, source);
          }
        }
        updated += 1;
      } else {
        const assetId = randomUUID();
        await tx.run(`
          INSERT INTO assets (
            id, organization_id, asset_tag, serial_number, model_name, model_id, brand, category,
            status, person_id, external_ids_json, import_meta_json, created_at, updated_at,
            ${importedAssetFields.map(([column]) => column).join(', ')}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${importedAssetFields.map(() => '?').join(', ')})
        `, [
          assetId,
          session.organizationId,
          row.assetTag,
          row.serialNumber,
          row.modelName,
          clean(row.modelId) || null,
          clean(row.brand) || null,
          clean(row.category) || null,
          personId ? 'assigned' : 'in_stock',
          personId,
          JSON.stringify(externalIds),
          JSON.stringify(importMeta),
          now,
          now,
          ...importedAssetValues(row)
        ]);
        touchedAssetIds.add(assetId);
        await recordAssetPresence(tx, session.organizationId, assetId, source, row, now);
        if (personId) {
          await openAssignment(tx, session.organizationId, assetId, personId, now, source);
        }
        created += 1;
      }
    }

    missingFromImport = await markMissingFromImport(
      tx,
      session.organizationId,
      source,
      touchedAssetIds,
      now
    );

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
        missingFromImport,
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
    missingFromImport,
    skipped: rows.length - selected.length
  };
  await addAudit(session, 'import.apply', 'import_batch', batchId, summary);
  return { ok: true, batchId, summary };
}

// Hardware fields the mappers can fill in. COALESCE on update keeps a value a
// human typed when the export has nothing to say about that column.
const importedAssetFields = [
  ['operating_system', 'operatingSystem'],
  ['ram_gb', 'ramGb'],
  ['storage_gb', 'storageGb'],
  ['cpu', 'cpu'],
  ['imei', 'imei'],
  ['enrolled_at', 'enrolledAt'],
  ['last_enrolled_at', 'lastEnrolledAt'],
  ['notes', 'notes'],
  ['location_key', 'location']
];

function importedAssetValues(row) {
  return importedAssetFields.map(([, field]) => {
    const value = row[field];
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'number' ? value : clean(value);
  });
}

/**
 * A device that an MDM stopped reporting is not deleted: it is flagged, so the
 * "missing from MDM" report can show what left the fleet without anyone
 * telling IT. Only assets last seen through the same source are considered,
 * and retired hardware is left alone.
 */
async function markMissingFromImport(tx, organizationId, source, touchedAssetIds, now) {
  const candidates = await tx.all(`
    SELECT id, import_meta_json AS "importMetaJson"
    FROM assets
    WHERE organization_id = ? AND status <> 'retired'
  `, [organizationId]);

  let missing = 0;
  for (const candidate of candidates) {
    const meta = parseJson(candidate.importMetaJson, {});
    if (clean(meta.source).toLowerCase() !== clean(source).toLowerCase()) continue;
    if (touchedAssetIds.has(candidate.id)) continue;
    missing += 1;
    if (meta.missingFromLastImport) continue;
    await tx.run(
      'UPDATE assets SET import_meta_json = ?, updated_at = ? WHERE id = ? AND organization_id = ?',
      [
        JSON.stringify({ ...meta, missingFromLastImport: true, missingDetectedAt: now }),
        now,
        candidate.id,
        organizationId
      ]
    );
  }
  return missing;
}

async function createUserImportPreview(session, upload) {
  const [existingPeople, policy, profiles] = await Promise.all([
    listPeople(session.organizationId),
    loadImportPolicy(session.organizationId),
    listImportProfiles(db, session.organizationId)
  ]);
  const mapping = parseOptionalJsonField(upload.fields.mapping);
  const preview = buildSaasUserImportPreview({
    buffer: upload.file.buffer,
    fileName: upload.file.originalName,
    source: upload.fields.source || 'auto',
    existingPeople,
    policy,
    mapping,
    profiles,
    profileId: clean(upload.fields.profileId)
  });

  if (preview.needsMapping) {
    return preview;
  }

  const saveAsProfile = clean(upload.fields.saveAsProfile);
  let profileId = preview.profileId || '';
  if (saveAsProfile && preview.mapping) {
    const profile = await createImportProfile(db, session.organizationId, {
      name: saveAsProfile,
      presetKey: preview.source,
      headerSignature: preview.headerSignature || clean(upload.fields.headerSignature),
      mapping: preview.mapping
    });
    profileId = profile.id;
    await addAudit(session, 'import.profile_create', 'import_profile', profile.id, {
      name: profile.name,
      fromPreview: true
    });
  }

  const batchId = randomUUID();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO import_batches (
        id, organization_id, user_id, kind, source, file_name, status, summary_json, policy_json, profile_id, created_at
      ) VALUES (?, ?, ?, 'users', ?, ?, 'preview', ?, '{}', ?, ?)
    `, [
      batchId,
      session.organizationId,
      session.userId,
      preview.source,
      preview.fileName,
      JSON.stringify(preview.summary),
      profileId || null,
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

  await addAudit(session, 'import.users.preview', 'import_batch', batchId, {
    source: preview.source,
    fileName: preview.fileName,
    summary: preview.summary
  });
  return { ...preview, batchId, profileId };
}

async function applyUserImportBatch(session, input) {
  const batchId = clean(input.batchId);
  if (!batchId) throw badRequest('batchId is required');
  const batch = await db.get(
    'SELECT * FROM import_batches WHERE id = ? AND organization_id = ?',
    [batchId, session.organizationId]
  );
  if (!batch) throw notFound('Import batch not found');
  if (batch.kind !== 'users') throw badRequest('Import batch does not contain users');
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

  await db.transaction(async (tx) => {
    for (const stored of selected) {
      const row = JSON.parse(stored.dataJson);
      const email = clean(row.email).toLowerCase();
      if (!email) continue;
      const existing = await tx.get(`
        SELECT id, external_ids_json AS "externalIdsJson"
        FROM people
        WHERE organization_id = ? AND LOWER(email) = LOWER(?)
        LIMIT 1
      `, [session.organizationId, email]);

      if (existing) {
        await tx.run(`
          UPDATE people
          SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
              department = COALESCE(?, department), role_title = COALESCE(?, role_title),
              status = ?, external_ids_json = ?, updated_at = ?
          WHERE id = ? AND organization_id = ?
        `, [
          clean(row.firstName) || null,
          clean(row.lastName) || null,
          clean(row.department) || null,
          clean(row.role) || null,
          row.status === 'inactive' ? 'inactive' : 'active',
          JSON.stringify(normalizePersonExternalIds({
            ...parseJson(existing.externalIdsJson, {}),
            ...row.externalIds
          })),
          now,
          existing.id,
          session.organizationId
        ]);
        await recordPersonPresence(tx, session.organizationId, existing.id, batch.source, row, now);
        updated += 1;
      } else {
        const personId = randomUUID();
        await tx.run(`
          INSERT INTO people (
            id, organization_id, first_name, last_name, email, department, role_title,
            status, external_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          personId,
          session.organizationId,
          clean(row.firstName) || 'Unknown',
          clean(row.lastName) || '-',
          email,
          clean(row.department),
          clean(row.role),
          row.status === 'inactive' ? 'inactive' : 'active',
          JSON.stringify(normalizePersonExternalIds(row.externalIds)),
          now,
          now
        ]);
        await recordPersonPresence(tx, session.organizationId, personId, batch.source, row, now);
        created += 1;
      }
    }

    await tx.run(`
      UPDATE import_batches
      SET status = 'applied', applied_at = ?, summary_json = ?
      WHERE id = ? AND organization_id = ?
    `, [
      now,
      JSON.stringify({ created, updated, skipped: rows.length - selected.length }),
      batchId,
      session.organizationId
    ]);
  });

  const summary = { created, updated, skipped: rows.length - selected.length };
  await addAudit(session, 'import.users.apply', 'import_batch', batchId, summary);
  return { ok: true, batchId, summary };
}

/**
 * Where a device or person was last seen, per source. The exception engine
 * compares these instead of re-reading import notes, and a later live
 * connector writes the same shape.
 */
async function recordAssetPresence(tx, organizationId, assetId, source, row, now) {
  const current = await tx.get(
    'SELECT source_presence_json AS "presence", last_seen_at AS "lastSeenAt" FROM assets WHERE id = ? AND organization_id = ?',
    [assetId, organizationId]
  );
  const presence = parseJson(current?.presence, {});
  const seenAt = clean(row.lastSeenAt) || null;
  presence[presenceKey(source)] = {
    importedAt: now,
    seenAt,
    externalId: clean(row.externalId),
    reportedUserEmail: clean(row.person?.email).toLowerCase()
  };
  const latest = [current?.lastSeenAt, seenAt].filter(Boolean).sort().pop() || null;
  await tx.run(
    'UPDATE assets SET source_presence_json = ?, last_seen_at = ? WHERE id = ? AND organization_id = ?',
    [JSON.stringify(presence), latest, assetId, organizationId]
  );
}

async function recordPersonPresence(tx, organizationId, personId, source, row, now) {
  const current = await tx.get(
    'SELECT source_presence_json AS "presence" FROM people WHERE id = ? AND organization_id = ?',
    [personId, organizationId]
  );
  const presence = parseJson(current?.presence, {});
  presence[presenceKey(source)] = {
    importedAt: now,
    enabled: row.status !== 'inactive'
  };
  await tx.run(`
    UPDATE people
    SET source_presence_json = ?, manager_email = COALESCE(?, manager_email), last_synced_at = ?
    WHERE id = ? AND organization_id = ?
  `, [JSON.stringify(presence), clean(row.manager) || null, now, personId, organizationId]);
}

function presenceKey(source) {
  const value = clean(source).toLowerCase() || 'import';
  return value === 'intune_users' ? 'intune' : value;
}

async function findAssetForImport(tx, organizationId, row) {
  const externalId = clean(row.externalId);
  if (externalId) {
    // External ids are stored as JSON; both dialects support LIKE for a first pass.
    const byExternal = await tx.all(`
      SELECT id, status, person_id, external_ids_json, import_meta_json
      FROM assets
      WHERE organization_id = ? AND external_ids_json LIKE ?
    `, [organizationId, `%${externalId}%`]);
    const match = byExternal.find((asset) => {
      const ids = parseJson(asset.external_ids_json, {});
      return Object.values(ids).some((value) => clean(value) === externalId);
    });
    if (match) return match;
  }
  if (clean(row.serialNumber)) {
    const bySerial = await tx.get(`
      SELECT id, status, person_id, external_ids_json, import_meta_json
      FROM assets
      WHERE organization_id = ? AND LOWER(serial_number) = LOWER(?)
    `, [organizationId, row.serialNumber]);
    if (bySerial) return bySerial;
  }
  if (clean(row.assetTag)) {
    return tx.get(`
      SELECT id, status, person_id, external_ids_json, import_meta_json
      FROM assets
      WHERE organization_id = ? AND LOWER(asset_tag) = LOWER(?)
    `, [organizationId, row.assetTag]);
  }
  return null;
}

function buildExternalIds(source, externalId) {
  const value = clean(externalId);
  if (!value) return {};
  if (source === 'jamf') return { jamfComputerId: value };
  return { intuneDeviceId: value };
}

async function openAssignment(tx, organizationId, assetId, personId, startedAt, source) {
  await tx.run(`
    INSERT INTO asset_assignments (
      id, organization_id, asset_id, person_id, started_at, ended_at, end_reason, source
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
  `, [randomUUID(), organizationId, assetId, personId, startedAt, source]);
}

async function closeOpenAssignment(tx, organizationId, assetId, endedAt, endReason) {
  await tx.run(`
    UPDATE asset_assignments
    SET ended_at = ?, end_reason = ?
    WHERE asset_id = ? AND organization_id = ? AND ended_at IS NULL
  `, [endedAt, endReason, assetId, organizationId]);
}

async function getOrganizationSettings(organizationId) {
  const row = await db.get(
    'SELECT * FROM organization_settings WHERE organization_id = ?',
    [organizationId]
  );
  if (!row) {
    return {
      excludedEmails: [],
      excludedNameRules: [],
      identityGroups: [],
      modelOverrides: {}
    };
  }
  return {
    excludedEmails: parseJson(row.excluded_emails_json, []),
    excludedNameRules: parseJson(row.excluded_name_rules_json, []),
    identityGroups: parseJson(row.identity_groups_json, []),
    modelOverrides: parseJson(row.model_overrides_json, {})
  };
}

async function updateOrganizationSettings(session, input) {
  const before = await getOrganizationSettings(session.organizationId);
  const next = {
    excludedEmails: Array.isArray(input.excludedEmails)
      ? [...new Set(input.excludedEmails.map((value) => clean(value).toLowerCase()).filter(Boolean))]
      : before.excludedEmails,
    excludedNameRules: Array.isArray(input.excludedNameRules)
      ? input.excludedNameRules
        .map((rule, index) => ({
          id: clean(rule.id) || `rule-${index + 1}`,
          tokens: (rule.tokens || []).map((token) => clean(token).toLowerCase()).filter(Boolean)
        }))
        .filter((rule) => rule.tokens.length)
      : before.excludedNameRules,
    identityGroups: Array.isArray(input.identityGroups)
      ? input.identityGroups.map((group) => ({
          emails: [...new Set((group.emails || []).map((email) => clean(email).toLowerCase()).filter(Boolean))],
          firstName: clean(group.firstName),
          lastName: clean(group.lastName)
        }))
      : before.identityGroups,
    modelOverrides: input.modelOverrides && typeof input.modelOverrides === 'object'
      ? { ...input.modelOverrides }
      : before.modelOverrides
  };
  const now = new Date().toISOString();
  await db.run(`
    INSERT INTO organization_settings (
      organization_id, excluded_emails_json, excluded_name_rules_json,
      identity_groups_json, model_overrides_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (organization_id) DO UPDATE SET
      excluded_emails_json = ?,
      excluded_name_rules_json = ?,
      identity_groups_json = ?,
      model_overrides_json = ?,
      updated_at = ?
  `, [
    session.organizationId,
    JSON.stringify(next.excludedEmails),
    JSON.stringify(next.excludedNameRules),
    JSON.stringify(next.identityGroups),
    JSON.stringify(next.modelOverrides),
    now,
    JSON.stringify(next.excludedEmails),
    JSON.stringify(next.excludedNameRules),
    JSON.stringify(next.identityGroups),
    JSON.stringify(next.modelOverrides),
    now
  ]);
  await addAudit(session, 'settings.update', 'organization', session.organizationId, {
    before,
    after: next
  });
  return next;
}

async function loadImportPolicy(organizationId) {
  const settings = await getOrganizationSettings(organizationId);
  return createImportPolicy(settings);
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mergeJson(existingRaw, patch) {
  return { ...parseJson(existingRaw, {}), ...patch };
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

function sendCsv(res, csv, fileName) {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store'
  });
  res.end(csv);
}

// Intune hands out a ZIP that wraps the inventory CSV; the shared reader pulls
// the first CSV out of it, so both extensions are accepted here.
function requireImportFile(upload) {
  const name = upload.file.originalName.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.zip')) {
    throw badRequest('Only CSV or ZIP files are supported');
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

async function resolveAssetStatus(organizationId, status) {
  const statuses = await listOptions(db, organizationId, 'status');
  const validation = validateStatus(status || 'in_stock', statuses);
  if (!validation.valid) throw badRequest(validation.reason || 'Unknown status');
  return validation.key;
}

async function resolveLocationValue(organizationId, locationKey) {
  const key = clean(locationKey);
  if (!key) return '';
  const locations = await listOptions(db, organizationId, 'location');
  const validation = validateLocation(key, locations);
  if (!validation.valid) throw badRequest(validation.reason || 'Unknown location');
  return validation.key;
}

async function resolveDepartmentValue(organizationId, department) {
  const label = clean(department);
  if (!label) return '';
  const created = await ensureDepartmentOption(db, organizationId, label);
  return created?.label || label;
}

async function resolveCustomValues(organizationId, entity, custom) {
  const fields = await listCustomFields(db, organizationId, entity);
  const validation = validateCustomFields(custom || {}, fields);
  if (!validation.valid) throw badRequest(validation.errors.join('; '));
  return validation.values;
}

function parseOptionalJsonField(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    throw badRequest('mapping must be valid JSON');
  }
}

function isUniqueViolation(error) {
  return error?.code === '23505' || String(error?.message || '').toLowerCase().includes('unique');
}

async function enforceRateLimit(req, bucket, limit, windowMs) {
  const clientKey = clientIp(req);
  const now = Date.now();
  const windowStart = now - (now % windowMs);
  try {
    const existing = await db.get(`
      SELECT count FROM rate_limits
      WHERE bucket = ? AND client_key = ? AND window_start = ?
    `, [bucket, clientKey, windowStart]);
    const count = Number(existing?.count || 0) + 1;
    if (count > limit) {
      const error = new Error('Too many requests. Try again later.');
      error.status = 429;
      throw error;
    }
    if (existing) {
      await db.run(`
        UPDATE rate_limits SET count = ?
        WHERE bucket = ? AND client_key = ? AND window_start = ?
      `, [count, bucket, clientKey, windowStart]);
    } else {
      await db.run(`
        INSERT INTO rate_limits (bucket, client_key, window_start, count)
        VALUES (?, ?, ?, 1)
      `, [bucket, clientKey, windowStart]);
      // Opportunistic prune of windows that can no longer match.
      if (Math.random() < 0.02) {
        await db.run('DELETE FROM rate_limits WHERE window_start < ?', [now - windowMs * 2]);
      }
    }
    return;
  } catch (error) {
    if (error.status === 429) throw error;
    // Fall back to the in-memory map if the table is unavailable mid-migration.
    const key = `${bucket}:${clientKey}`;
    const current = rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      const limited = new Error('Too many requests. Try again later.');
      limited.status = 429;
      throw limited;
    }
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

function addSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwardedProto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
