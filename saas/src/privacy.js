/**
 * GDPR helpers that stay free: person erasure scrubbing, organization JSON
 * export, and retention cleanup. No paid infra — callers run cleanup via the
 * admin API or `npm run retention:cleanup` on a free cron / laptop.
 */

export const DEFAULT_RETENTION = {
  previewDays: 7,
  importDays: 30,
  auditDays: 365,
  scrubAppliedImportRows: true
};

const ERASED = '[erased]';
const PII_KEYS = new Set([
  'email',
  'firstName',
  'lastName',
  'name',
  'department',
  'role',
  'roleTitle',
  'manager',
  'managerEmail',
  'reportedUserEmail',
  'upn',
  'jamfUsername',
  'alternateEmails'
]);

export function normalizeRetention(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const previewDays = positiveInt(value.previewDays, DEFAULT_RETENTION.previewDays);
  const importDays = positiveInt(value.importDays, DEFAULT_RETENTION.importDays);
  const auditDays = positiveInt(value.auditDays, DEFAULT_RETENTION.auditDays);
  return {
    previewDays,
    importDays: Math.max(importDays, previewDays),
    auditDays,
    scrubAppliedImportRows: value.scrubAppliedImportRows === undefined
      ? DEFAULT_RETENTION.scrubAppliedImportRows
      : Boolean(value.scrubAppliedImportRows)
  };
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(Math.floor(number), 3650);
}

export function personEmailSet(person) {
  const ids = person?.externalIds || parseMaybeJson(person?.external_ids_json, {}) || {};
  return new Set(
    [
      person?.email,
      ids.upn,
      ids.jamfUsername,
      ...(ids.alternateEmails || [])
    ]
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Article 17 erasure for one people row: remove the record and scrub residual
 * PII in import previews, exceptions, source presence, manager links and
 * matching audit detail values. Audit action rows stay (legitimate interest /
 * accountability) with emails replaced by [erased].
 */
export async function erasePerson(db, organizationId, personId) {
  const person = await db.get(
    'SELECT * FROM people WHERE id = ? AND organization_id = ?',
    [personId, organizationId]
  );
  if (!person) return null;

  const emails = personEmailSet({
    email: person.email,
    externalIds: parseMaybeJson(person.external_ids_json, {})
  });

  const scrubbed = {
    importRows: 0,
    exceptions: 0,
    exceptionDetails: 0,
    assetsPresence: 0,
    managersCleared: 0,
    settingsTouched: 0,
    auditDetails: 0
  };

  await db.transaction(async (tx) => {
    scrubbed.importRows = await scrubImportRows(tx, organizationId, personId, emails);
    const exceptionResult = await scrubExceptions(tx, organizationId, personId, emails);
    scrubbed.exceptions = exceptionResult.deleted;
    scrubbed.exceptionDetails = exceptionResult.updated;
    scrubbed.assetsPresence = await scrubAssetPresence(tx, organizationId, emails);
    scrubbed.managersCleared = await clearManagerEmails(tx, organizationId, emails);
    scrubbed.settingsTouched = await scrubOrganizationSettings(tx, organizationId, emails);
    scrubbed.auditDetails = await scrubAuditDetails(tx, organizationId, personId, emails);

    await tx.run('DELETE FROM people WHERE id = ? AND organization_id = ?', [
      personId,
      organizationId
    ]);
  });

  return { id: personId, scrubbed };
}

async function scrubImportRows(tx, organizationId, personId, emails) {
  const rows = await tx.all(
    'SELECT id, data_json AS "dataJson" FROM import_rows WHERE organization_id = ?',
    [organizationId]
  );
  let changed = 0;
  for (const row of rows) {
    const data = parseMaybeJson(row.dataJson, null);
    if (!data) continue;
    const next = scrubValue(data, emails, personId);
    if (JSON.stringify(next) === JSON.stringify(data)) continue;
    await tx.run('UPDATE import_rows SET data_json = ? WHERE id = ?', [
      JSON.stringify(next),
      row.id
    ]);
    changed += 1;
  }
  return changed;
}

async function scrubExceptions(tx, organizationId, personId, emails) {
  const deleted = (await tx.run(
    `DELETE FROM exceptions
     WHERE organization_id = ? AND entity_type = 'person' AND entity_id = ?`,
    [organizationId, personId]
  )).changes;

  const rows = await tx.all(
    `SELECT id, details_json AS "detailsJson"
     FROM exceptions
     WHERE organization_id = ?`,
    [organizationId]
  );
  let updated = 0;
  for (const row of rows) {
    const details = parseMaybeJson(row.detailsJson, {});
    const next = scrubValue(details, emails, personId);
    if (JSON.stringify(next) === JSON.stringify(details)) continue;
    await tx.run('UPDATE exceptions SET details_json = ? WHERE id = ?', [
      JSON.stringify(next),
      row.id
    ]);
    updated += 1;
  }
  return { deleted, updated };
}

async function scrubAssetPresence(tx, organizationId, emails) {
  const assets = await tx.all(
    `SELECT id, source_presence_json AS "presenceJson"
     FROM assets WHERE organization_id = ?`,
    [organizationId]
  );
  let changed = 0;
  for (const asset of assets) {
    const presence = parseMaybeJson(asset.presenceJson, {});
    if (!presence || typeof presence !== 'object') continue;
    let touched = false;
    for (const entry of Object.values(presence)) {
      if (!entry || typeof entry !== 'object') continue;
      const reported = String(entry.reportedUserEmail || '').trim().toLowerCase();
      if (reported && emails.has(reported)) {
        entry.reportedUserEmail = ERASED;
        touched = true;
      }
    }
    if (!touched) continue;
    await tx.run(
      'UPDATE assets SET source_presence_json = ? WHERE id = ? AND organization_id = ?',
      [JSON.stringify(presence), asset.id, organizationId]
    );
    changed += 1;
  }
  return changed;
}

async function clearManagerEmails(tx, organizationId, emails) {
  let cleared = 0;
  for (const email of emails) {
    cleared += (await tx.run(
      `UPDATE people SET manager_email = NULL, updated_at = ?
       WHERE organization_id = ? AND LOWER(manager_email) = ?`,
      [new Date().toISOString(), organizationId, email]
    )).changes;
  }
  return cleared;
}

async function scrubOrganizationSettings(tx, organizationId, emails) {
  const row = await tx.get(
    'SELECT * FROM organization_settings WHERE organization_id = ?',
    [organizationId]
  );
  if (!row) return 0;

  const beforeExcluded = parseMaybeJson(row.excluded_emails_json, []);
  const beforeGroups = parseMaybeJson(row.identity_groups_json, []);
  const excludedEmails = beforeExcluded
    .filter((email) => !emails.has(String(email).toLowerCase()));
  const identityGroups = beforeGroups.map((group) => ({
    ...group,
    emails: (group.emails || []).filter((email) => !emails.has(String(email).toLowerCase()))
  })).filter((group) => (group.emails || []).length);

  if (
    JSON.stringify(beforeExcluded) === JSON.stringify(excludedEmails)
    && JSON.stringify(beforeGroups) === JSON.stringify(identityGroups)
  ) {
    return 0;
  }

  await tx.run(
    `UPDATE organization_settings
     SET excluded_emails_json = ?, identity_groups_json = ?, updated_at = ?
     WHERE organization_id = ?`,
    [
      JSON.stringify(excludedEmails),
      JSON.stringify(identityGroups),
      new Date().toISOString(),
      organizationId
    ]
  );
  return 1;
}

async function scrubAuditDetails(tx, organizationId, personId, emails) {
  const rows = await tx.all(
    `SELECT id, entity_id AS "entityId", details_json AS "detailsJson"
     FROM audit_logs WHERE organization_id = ?`,
    [organizationId]
  );
  let changed = 0;
  for (const row of rows) {
    const details = parseMaybeJson(row.detailsJson, {});
    const next = scrubValue(details, emails, personId);
    if (JSON.stringify(next) === JSON.stringify(details)) continue;
    await tx.run('UPDATE audit_logs SET details_json = ? WHERE id = ?', [
      JSON.stringify(next),
      row.id
    ]);
    changed += 1;
  }
  return changed;
}

export function scrubValue(value, emails, personId) {
  if (value == null) return value;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (emails.has(lower)) return ERASED;
    if (personId && value === personId) return value;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, emails, personId));
  }
  if (typeof value !== 'object') return value;

  const out = Array.isArray(value) ? [] : { ...value };
  for (const [key, child] of Object.entries(value)) {
    if (key === 'id' || key === 'entityId' || key === 'personId' || key === 'existingPersonId' || key === 'previousPersonId') {
      if (child === personId) {
        out[key] = personId;
        continue;
      }
    }
    if (PII_KEYS.has(key)) {
      if (typeof child === 'string' && (emails.has(child.trim().toLowerCase()) || child.trim())) {
        // Only erase when this object is about the erased person, or the value is their email.
        const lower = child.trim().toLowerCase();
        if (emails.has(lower) || objectMentionsPerson(value, emails, personId)) {
          out[key] = Array.isArray(child) ? [] : (key === 'alternateEmails' ? [] : ERASED);
          continue;
        }
      }
      if (Array.isArray(child) && key === 'alternateEmails') {
        out[key] = child.filter((email) => !emails.has(String(email).toLowerCase()));
        continue;
      }
    }
    out[key] = scrubValue(child, emails, personId);
  }

  if (out.person && objectMentionsPerson(out.person, emails, personId)) {
    out.person = {
      firstName: ERASED,
      lastName: ERASED,
      email: ERASED,
      department: '',
      role: '',
      erased: true
    };
  }
  if (out.assignedTo && objectMentionsPerson(out.assignedTo, emails, personId)) {
    out.assignedTo = { id: out.assignedTo.id || personId, name: ERASED, email: ERASED, erased: true };
  }
  if (out.reportedPerson && objectMentionsPerson(out.reportedPerson, emails, personId)) {
    out.reportedPerson = { id: out.reportedPerson.id || personId, name: ERASED, email: ERASED, erased: true };
  }
  if (out.person && out.person.id === personId) {
    out.person = { id: personId, name: ERASED, email: ERASED, erased: true };
  }
  return out;
}

function objectMentionsPerson(value, emails, personId) {
  if (!value || typeof value !== 'object') return false;
  if (value.id === personId || value.personId === personId) return true;
  const haystack = JSON.stringify(value).toLowerCase();
  for (const email of emails) {
    if (haystack.includes(email)) return true;
  }
  return false;
}

/**
 * Portability / exit export: everything the tenant owns except connector
 * secrets and raw import row payloads (those are transient working copies).
 */
export async function exportOrganization(db, organizationId) {
  const organization = await db.get(
    'SELECT id, name, slug, created_at AS "createdAt" FROM organizations WHERE id = ?',
    [organizationId]
  );
  if (!organization) return null;

  const [
    people,
    assets,
    assignments,
    members,
    settings,
    exceptions,
    audit,
    options,
    customFields,
    importProfiles,
    connections
  ] = await Promise.all([
    db.all(`
      SELECT id, first_name AS "firstName", last_name AS "lastName", email, department,
             role_title AS "role", status, external_ids_json AS "externalIdsJson",
             custom_json AS "customJson", source_presence_json AS "sourcePresenceJson",
             manager_email AS "manager", last_synced_at AS "lastSyncedAt",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM people WHERE organization_id = ?
      ORDER BY LOWER(last_name), LOWER(first_name)
    `, [organizationId]),
    db.all(`
      SELECT id, asset_tag AS "assetTag", serial_number AS "serialNumber", model_name AS "modelName",
             status, person_id AS "personId", category, brand, ram_gb AS "ramGb",
             storage_gb AS "storageGb", cpu, imei, operating_system AS "operatingSystem",
             warranty_ends_on AS "warrantyEndsOn", purchased_on AS "purchasedOn", vendor, notes,
             enrolled_at AS "enrolledAt", last_enrolled_at AS "lastEnrolledAt",
             last_seen_at AS "lastSeenAt", external_ids_json AS "externalIdsJson",
             import_meta_json AS "importMetaJson", source_presence_json AS "sourcePresenceJson",
             custom_json AS "customJson", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM assets WHERE organization_id = ?
      ORDER BY LOWER(asset_tag)
    `, [organizationId]),
    db.all(`
      SELECT id, asset_id AS "assetId", person_id AS "personId", started_at AS "startedAt",
             ended_at AS "endedAt", end_reason AS "endReason", source
      FROM asset_assignments WHERE organization_id = ?
      ORDER BY started_at
    `, [organizationId]),
    db.all(`
      SELECT u.id, u.email, u.name, m.role, m.created_at AS "joinedAt"
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ?
      ORDER BY LOWER(u.email)
    `, [organizationId]),
    db.get('SELECT * FROM organization_settings WHERE organization_id = ?', [organizationId]),
    db.all(`
      SELECT id, rule_key AS "ruleKey", entity_type AS "entityType", entity_id AS "entityId",
             fingerprint, severity, status, details_json AS "detailsJson",
             first_detected_at AS "firstDetectedAt", last_detected_at AS "lastDetectedAt",
             resolved_at AS "resolvedAt", resolution, snooze_until AS "snoozeUntil"
      FROM exceptions WHERE organization_id = ?
      ORDER BY last_detected_at DESC
    `, [organizationId]),
    db.all(`
      SELECT action, entity_type AS "entityType", entity_id AS "entityId",
             details_json AS "detailsJson", created_at AS "createdAt"
      FROM audit_logs WHERE organization_id = ?
      ORDER BY created_at DESC
      LIMIT 5000
    `, [organizationId]),
    db.all(`
      SELECT id, kind, key, label, meta_json AS "metaJson", archived_at AS "archivedAt",
             sort_order AS "sortOrder"
      FROM org_options WHERE organization_id = ?
      ORDER BY kind, sort_order, label
    `, [organizationId]),
    db.all(`
      SELECT id, entity, key, label, type, options_json AS "optionsJson", required,
             sort_order AS "sortOrder", archived_at AS "archivedAt"
      FROM custom_field_defs WHERE organization_id = ?
      ORDER BY entity, key
    `, [organizationId]),
    db.all(`
      SELECT id, name, preset_key AS "presetKey", header_signature AS "headerSignature",
             mapping_json AS "mappingJson", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM import_profiles WHERE organization_id = ?
      ORDER BY LOWER(name)
    `, [organizationId]),
    db.all(`
      SELECT id, provider, status, scopes_json AS "scopesJson", config_json AS "configJson",
             last_sync_at AS "lastSyncAt", last_error AS "lastError",
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM connections WHERE organization_id = ?
      ORDER BY provider
    `, [organizationId])
  ]);

  return {
    exportedAt: new Date().toISOString(),
    formatVersion: 1,
    organization,
    members,
    people: people.map(mapJsonFields),
    assets: assets.map(mapJsonFields),
    assignments,
    settings: settings
      ? {
          excludedEmails: parseMaybeJson(settings.excluded_emails_json, []),
          excludedNameRules: parseMaybeJson(settings.excluded_name_rules_json, []),
          identityGroups: parseMaybeJson(settings.identity_groups_json, []),
          modelOverrides: parseMaybeJson(settings.model_overrides_json, {}),
          exceptionRules: parseMaybeJson(settings.exception_rules_json, {}),
          retention: normalizeRetention(parseMaybeJson(settings.retention_json, {}))
        }
      : { ...emptySettings() },
    exceptions: exceptions.map(mapJsonFields),
    audit: audit.map(mapJsonFields),
    options: options.map(mapJsonFields),
    customFields: customFields.map(mapJsonFields),
    importProfiles: importProfiles.map(mapJsonFields),
    connections: connections.map(mapJsonFields)
  };
}

function emptySettings() {
  return {
    excludedEmails: [],
    excludedNameRules: [],
    identityGroups: [],
    modelOverrides: {},
    exceptionRules: {},
    retention: { ...DEFAULT_RETENTION }
  };
}

function mapJsonFields(row) {
  const out = { ...row };
  for (const [key, value] of Object.entries(row)) {
    if (!key.endsWith('Json') && !key.endsWith('_json')) continue;
    const plain = key.replace(/Json$/, '').replace(/_json$/, '');
    const camel = plain.includes('_')
      ? plain.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      : plain;
    out[camel === plain ? plain : camel] = parseMaybeJson(value, value == null ? null : {});
    if (key.endsWith('Json')) delete out[key];
  }
  // Prefer camelCase names used elsewhere in the API.
  if (out.externalIdsJson !== undefined) {
    out.externalIds = parseMaybeJson(out.externalIdsJson, {});
    delete out.externalIdsJson;
  }
  if (out.customJson !== undefined) {
    out.custom = parseMaybeJson(out.customJson, {});
    delete out.customJson;
  }
  if (out.sourcePresenceJson !== undefined) {
    out.sourcePresence = parseMaybeJson(out.sourcePresenceJson, {});
    delete out.sourcePresenceJson;
  }
  if (out.importMetaJson !== undefined) {
    out.importMeta = parseMaybeJson(out.importMetaJson, {});
    delete out.importMetaJson;
  }
  if (out.detailsJson !== undefined) {
    out.details = parseMaybeJson(out.detailsJson, {});
    delete out.detailsJson;
  }
  if (out.mappingJson !== undefined) {
    out.mapping = parseMaybeJson(out.mappingJson, {});
    delete out.mappingJson;
  }
  if (out.metaJson !== undefined) {
    out.meta = parseMaybeJson(out.metaJson, {});
    delete out.metaJson;
  }
  if (out.optionsJson !== undefined) {
    out.options = parseMaybeJson(out.optionsJson, []);
    delete out.optionsJson;
  }
  if (out.scopesJson !== undefined) {
    out.scopes = parseMaybeJson(out.scopesJson, []);
    delete out.scopesJson;
  }
  if (out.configJson !== undefined) {
    out.config = parseMaybeJson(out.configJson, {});
    delete out.configJson;
  }
  return out;
}

/**
 * Drop stale import working copies and old audit rows. Safe to run repeatedly.
 */
export async function runRetentionCleanup(db, { organizationId = null, now = new Date() } = {}) {
  const orgs = organizationId
    ? [{ id: organizationId }]
    : await db.all('SELECT id FROM organizations');

  const summary = {
    organizations: 0,
    previewBatchesDeleted: 0,
    importBatchesDeleted: 0,
    importRowsScrubbed: 0,
    auditDeleted: 0
  };

  for (const org of orgs) {
    const settingsRow = await db.get(
      'SELECT retention_json AS "retentionJson" FROM organization_settings WHERE organization_id = ?',
      [org.id]
    );
    const retention = normalizeRetention(parseMaybeJson(settingsRow?.retentionJson, {}));
    const previewCutoff = isoDaysAgo(now, retention.previewDays);
    const importCutoff = isoDaysAgo(now, retention.importDays);
    const auditCutoff = isoDaysAgo(now, retention.auditDays);

    const previewDeleted = await deleteBatches(db, org.id, {
      status: 'preview',
      olderThan: previewCutoff
    });
    const importDeleted = await deleteBatches(db, org.id, {
      status: ['applied', 'cancelled'],
      olderThan: importCutoff
    });

    let scrubbed = 0;
    if (retention.scrubAppliedImportRows) {
      scrubbed = await scrubAppliedImportPayloads(db, org.id);
    }

    const auditDeleted = (await db.run(
      `DELETE FROM audit_logs
       WHERE organization_id = ? AND created_at < ?`,
      [org.id, auditCutoff]
    )).changes;

    summary.organizations += 1;
    summary.previewBatchesDeleted += previewDeleted;
    summary.importBatchesDeleted += importDeleted;
    summary.importRowsScrubbed += scrubbed;
    summary.auditDeleted += auditDeleted;
  }

  return summary;
}

async function deleteBatches(db, organizationId, { status, olderThan }) {
  const statuses = Array.isArray(status) ? status : [status];
  const placeholders = statuses.map(() => '?').join(', ');
  const batches = await db.all(
    `SELECT id FROM import_batches
     WHERE organization_id = ? AND status IN (${placeholders}) AND created_at < ?`,
    [organizationId, ...statuses, olderThan]
  );
  for (const batch of batches) {
    await db.run('DELETE FROM import_rows WHERE batch_id = ?', [batch.id]);
    await db.run('DELETE FROM import_batches WHERE id = ?', [batch.id]);
  }
  return batches.length;
}

async function scrubAppliedImportPayloads(db, organizationId) {
  const rows = await db.all(`
    SELECT r.id, r.data_json AS "dataJson"
    FROM import_rows r
    JOIN import_batches b ON b.id = r.batch_id
    WHERE r.organization_id = ? AND b.status = 'applied'
  `, [organizationId]);
  let changed = 0;
  for (const row of rows) {
    const data = parseMaybeJson(row.dataJson, null);
    if (!data || data.scrubbed === true) continue;
    const minimal = {
      scrubbed: true,
      rowKey: data.rowKey || '',
      action: data.action || '',
      assetTag: data.asset?.assetTag || data.assetTag || '',
      serialNumber: data.asset?.serialNumber || data.serialNumber || ''
    };
    await db.run('UPDATE import_rows SET data_json = ? WHERE id = ?', [
      JSON.stringify(minimal),
      row.id
    ]);
    changed += 1;
  }
  return changed;
}

function isoDaysAgo(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function parseMaybeJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
