import { randomUUID } from 'node:crypto';
import { evaluateRules, getRule, mergeRuleSettings, RULES } from './rules.js';

const ACTIVE_STATUSES = new Set(['open', 'snoozed']);

export async function loadRuleSettings(db, organizationId) {
  const row = await db.get(
    'SELECT exception_rules_json AS "rulesJson" FROM organization_settings WHERE organization_id = ?',
    [organizationId]
  );
  return mergeRuleSettings(parseJson(row?.rulesJson, {}));
}

export async function saveRuleSettings(db, organizationId, input) {
  const current = await loadRuleSettings(db, organizationId);
  const merged = mergeRuleSettings({
    staleDays: input.staleDays ?? current.staleDays,
    duplicateSameCategoryThreshold: input.duplicateSameCategoryThreshold ?? current.duplicateSameCategoryThreshold,
    enabled: { ...current.enabled, ...(input.enabled || {}) }
  });
  const now = new Date().toISOString();
  const existing = await db.get(
    'SELECT organization_id FROM organization_settings WHERE organization_id = ?',
    [organizationId]
  );
  if (existing) {
    await db.run(
      'UPDATE organization_settings SET exception_rules_json = ?, updated_at = ? WHERE organization_id = ?',
      [JSON.stringify(merged), now, organizationId]
    );
  } else {
    await db.run(
      'INSERT INTO organization_settings (organization_id, exception_rules_json, updated_at) VALUES (?, ?, ?)',
      [organizationId, JSON.stringify(merged), now]
    );
  }
  return merged;
}

export async function loadSnapshot(db, organizationId) {
  const [people, assets] = await Promise.all([
    db.all(`
      SELECT id, first_name AS "firstName", last_name AS "lastName", email, department, status,
             external_ids_json AS "externalIdsJson", source_presence_json AS "sourcePresenceJson"
      FROM people WHERE organization_id = ?
    `, [organizationId]),
    db.all(`
      SELECT id, asset_tag AS "assetTag", serial_number AS "serialNumber", model_name AS "modelName",
             category, status, person_id AS "personId", last_seen_at AS "lastSeenAt",
             external_ids_json AS "externalIdsJson", import_meta_json AS "importMetaJson",
             source_presence_json AS "sourcePresenceJson"
      FROM assets WHERE organization_id = ?
    `, [organizationId])
  ]);
  return {
    people: people.map((row) => ({
      ...row,
      externalIds: parseJson(row.externalIdsJson, {}),
      sourcePresence: parseJson(row.sourcePresenceJson, {})
    })),
    assets: assets.map((row) => ({
      ...row,
      externalIds: parseJson(row.externalIdsJson, {}),
      importMeta: parseJson(row.importMetaJson, {}),
      sourcePresence: parseJson(row.sourcePresenceJson, {})
    }))
  };
}

/**
 * Recomputes one organization's exceptions. Findings are matched on their
 * fingerprint, so a repeated scan refreshes rows instead of adding new ones;
 * an open exception whose condition disappeared is closed as `auto`, and a
 * resolved one that shows up again is reopened. Dismissed exceptions stay
 * dismissed: somebody decided that case is acceptable.
 */
export async function runExceptionScan(db, organizationId, { now = new Date(), userId = null } = {}) {
  const settings = await loadRuleSettings(db, organizationId);
  const snapshot = await loadSnapshot(db, organizationId);
  const findings = evaluateRules(snapshot, settings, now);
  const nowIso = now.toISOString();

  const existingRows = await db.all(`
    SELECT id, fingerprint, status, snooze_until AS "snoozeUntil", rule_key AS "ruleKey"
    FROM exceptions WHERE organization_id = ?
  `, [organizationId]);
  const existing = new Map(existingRows.map((row) => [row.fingerprint, row]));
  const seen = new Set();
  const counts = { detected: 0, reopened: 0, autoResolved: 0, unchanged: 0 };

  await db.transaction(async (tx) => {
    for (const finding of findings) {
      if (seen.has(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
      const current = existing.get(finding.fingerprint);

      if (!current) {
        const id = randomUUID();
        await tx.run(`
          INSERT INTO exceptions (
            id, organization_id, rule_key, entity_type, entity_id, fingerprint, severity,
            status, details_json, first_detected_at, last_detected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
        `, [
          id, organizationId, finding.ruleKey, finding.entityType, finding.entityId,
          finding.fingerprint, finding.severity, JSON.stringify(finding.details), nowIso, nowIso
        ]);
        await addEvent(tx, organizationId, id, userId, 'detected', null, nowIso);
        counts.detected += 1;
        continue;
      }

      let status = current.status;
      let kind = null;
      if (status === 'resolved') {
        status = 'open';
        kind = 'reopened';
      } else if (status === 'snoozed' && current.snoozeUntil && current.snoozeUntil <= nowIso) {
        status = 'open';
        kind = 'snooze_expired';
      }

      await tx.run(`
        UPDATE exceptions
        SET severity = ?, details_json = ?, last_detected_at = ?, status = ?, entity_id = ?,
            resolved_at = CASE WHEN ? = 'open' THEN NULL ELSE resolved_at END,
            resolved_by = CASE WHEN ? = 'open' THEN NULL ELSE resolved_by END,
            resolution = CASE WHEN ? = 'open' THEN NULL ELSE resolution END,
            snooze_until = CASE WHEN ? = 'open' THEN NULL ELSE snooze_until END
        WHERE id = ? AND organization_id = ?
      `, [
        finding.severity, JSON.stringify(finding.details), nowIso, status, finding.entityId,
        status, status, status, status, current.id, organizationId
      ]);
      if (kind) {
        await addEvent(tx, organizationId, current.id, userId, kind, null, nowIso);
        counts.reopened += 1;
      } else {
        counts.unchanged += 1;
      }
    }

    for (const row of existingRows) {
      if (seen.has(row.fingerprint) || !ACTIVE_STATUSES.has(row.status)) continue;
      await tx.run(`
        UPDATE exceptions
        SET status = 'resolved', resolved_at = ?, resolution = 'auto', resolved_by = NULL, snooze_until = NULL
        WHERE id = ? AND organization_id = ?
      `, [nowIso, row.id, organizationId]);
      await addEvent(tx, organizationId, row.id, userId, 'auto_resolved', null, nowIso);
      counts.autoResolved += 1;
    }
  });

  const open = await db.get(
    "SELECT COUNT(*) AS count FROM exceptions WHERE organization_id = ? AND status = 'open'",
    [organizationId]
  );
  return { ...counts, open: Number(open?.count || 0), scannedAt: nowIso };
}

export async function listExceptions(db, organizationId, filters = {}) {
  const where = ['e.organization_id = ?'];
  const params = [organizationId];
  const status = clean(filters.status);
  if (status === 'active') {
    where.push("e.status IN ('open', 'snoozed')");
  } else if (status) {
    where.push('e.status = ?');
    params.push(status);
  }
  for (const [column, value] of [['e.rule_key', filters.rule], ['e.severity', filters.severity]]) {
    if (clean(value)) {
      where.push(`${column} = ?`);
      params.push(clean(value));
    }
  }
  if (clean(filters.assignee) === 'unassigned') {
    where.push('e.assignee_user_id IS NULL');
  } else if (clean(filters.assignee)) {
    where.push('e.assignee_user_id = ?');
    params.push(clean(filters.assignee));
  }
  if (clean(filters.entityType) && clean(filters.entityId)) {
    where.push('e.entity_type = ? AND e.entity_id = ?');
    params.push(clean(filters.entityType), clean(filters.entityId));
  }
  const rows = await db.all(`
    SELECT e.id, e.rule_key AS "ruleKey", e.entity_type AS "entityType", e.entity_id AS "entityId",
           e.severity, e.status, e.details_json AS "detailsJson",
           e.assignee_user_id AS "assigneeUserId", u.name AS "assigneeName",
           e.first_detected_at AS "firstDetectedAt", e.last_detected_at AS "lastDetectedAt",
           e.resolved_at AS "resolvedAt", e.resolution, e.snooze_until AS "snoozeUntil"
    FROM exceptions e
    LEFT JOIN users u ON u.id = e.assignee_user_id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE e.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             e.last_detected_at DESC, e.id
  `, params);
  return rows.map(presentException);
}

export async function getException(db, organizationId, id) {
  const [row] = await db.all(`
    SELECT e.id, e.rule_key AS "ruleKey", e.entity_type AS "entityType", e.entity_id AS "entityId",
           e.severity, e.status, e.details_json AS "detailsJson",
           e.assignee_user_id AS "assigneeUserId", u.name AS "assigneeName",
           e.first_detected_at AS "firstDetectedAt", e.last_detected_at AS "lastDetectedAt",
           e.resolved_at AS "resolvedAt", e.resolution, e.snooze_until AS "snoozeUntil"
    FROM exceptions e
    LEFT JOIN users u ON u.id = e.assignee_user_id
    WHERE e.organization_id = ? AND e.id = ?
  `, [organizationId, id]);
  if (!row) return null;
  const events = await db.all(`
    SELECT ev.id, ev.kind, ev.note, ev.created_at AS "createdAt", ev.user_id AS "userId", u.name AS "userName"
    FROM exception_events ev
    LEFT JOIN users u ON u.id = ev.user_id
    WHERE ev.organization_id = ? AND ev.exception_id = ?
    ORDER BY ev.created_at, ev.id
  `, [organizationId, id]);
  return { ...presentException(row), events };
}

export async function summarizeExceptions(db, organizationId) {
  const rows = await db.all(`
    SELECT rule_key AS "ruleKey", severity, COUNT(*) AS count
    FROM exceptions
    WHERE organization_id = ? AND status = 'open'
    GROUP BY rule_key, severity
  `, [organizationId]);
  const byRule = RULES.map((rule) => ({
    ruleKey: rule.key,
    label: rule.label,
    count: rows.filter((row) => row.ruleKey === rule.key).reduce((sum, row) => sum + Number(row.count), 0)
  }));
  const bySeverity = ['high', 'medium', 'low'].map((severity) => ({
    severity,
    count: rows.filter((row) => row.severity === severity).reduce((sum, row) => sum + Number(row.count), 0)
  }));
  return {
    open: bySeverity.reduce((sum, item) => sum + item.count, 0),
    byRule,
    bySeverity
  };
}

/**
 * Human workflow on one exception. Nothing here touches Entra or Jamf; the
 * only side effect is on the exception row, its history and the audit log.
 */
export async function updateException(db, organizationId, id, input, userId) {
  const current = await db.get(
    'SELECT id, status FROM exceptions WHERE id = ? AND organization_id = ?',
    [id, organizationId]
  );
  if (!current) throw httpError(404, 'Exception not found');
  const action = clean(input.action);
  const note = clean(input.note) || null;
  const nowIso = new Date().toISOString();

  if (action === 'assign') {
    const assignee = input.assigneeUserId === undefined ? userId : (clean(input.assigneeUserId) || null);
    if (assignee) {
      const member = await db.get(
        'SELECT user_id FROM memberships WHERE organization_id = ? AND user_id = ?',
        [organizationId, assignee]
      );
      if (!member) throw httpError(400, 'Assignee is not a member of this organization');
    }
    await db.run(
      'UPDATE exceptions SET assignee_user_id = ? WHERE id = ? AND organization_id = ?',
      [assignee, id, organizationId]
    );
    await addEvent(db, organizationId, id, userId, assignee ? 'assigned' : 'unassigned', note, nowIso);
  } else if (action === 'snooze') {
    const until = clean(input.until);
    const parsed = Date.parse(until);
    if (!until || !Number.isFinite(parsed) || parsed <= Date.now()) {
      throw httpError(400, 'until must be a future date');
    }
    await db.run(
      "UPDATE exceptions SET status = 'snoozed', snooze_until = ? WHERE id = ? AND organization_id = ?",
      [new Date(parsed).toISOString(), id, organizationId]
    );
    await addEvent(db, organizationId, id, userId, 'snoozed', note, nowIso);
  } else if (action === 'resolve' || action === 'dismiss') {
    const status = action === 'resolve' ? 'resolved' : 'dismissed';
    await db.run(`
      UPDATE exceptions
      SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?, snooze_until = NULL
      WHERE id = ? AND organization_id = ?
    `, [status, nowIso, userId, action === 'resolve' ? 'manual' : 'dismissed', id, organizationId]);
    await addEvent(db, organizationId, id, userId, status, note, nowIso);
  } else if (action === 'reopen') {
    await db.run(`
      UPDATE exceptions
      SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolution = NULL, snooze_until = NULL
      WHERE id = ? AND organization_id = ?
    `, [id, organizationId]);
    await addEvent(db, organizationId, id, userId, 'reopened', note, nowIso);
  } else if (action === 'comment') {
    if (!note) throw httpError(400, 'note is required');
    await addEvent(db, organizationId, id, userId, 'comment', note, nowIso);
  } else {
    throw httpError(400, 'action must be one of assign, snooze, resolve, dismiss, reopen, comment');
  }
  return getException(db, organizationId, id);
}

function presentException(row) {
  const rule = getRule(row.ruleKey);
  return {
    id: row.id,
    ruleKey: row.ruleKey,
    ruleLabel: rule?.label || row.ruleKey,
    entityType: row.entityType,
    entityId: row.entityId,
    severity: row.severity,
    status: row.status,
    details: parseJson(row.detailsJson, {}),
    assigneeUserId: row.assigneeUserId || null,
    assigneeName: row.assigneeName || '',
    firstDetectedAt: row.firstDetectedAt,
    lastDetectedAt: row.lastDetectedAt,
    resolvedAt: row.resolvedAt || null,
    resolution: row.resolution || null,
    snoozeUntil: row.snoozeUntil || null
  };
}

async function addEvent(db, organizationId, exceptionId, userId, kind, note, createdAt) {
  await db.run(`
    INSERT INTO exception_events (id, organization_id, exception_id, user_id, kind, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [randomUUID(), organizationId, exceptionId, userId || null, kind, note, createdAt]);
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function clean(value) {
  return String(value ?? '').trim();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
