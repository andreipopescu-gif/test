const DAY_MS = 24 * 60 * 60 * 1000;
const RETIRED = new Set(['retired']);

export const DEFAULT_RULE_SETTINGS = {
  staleDays: 30,
  duplicateSameCategoryThreshold: 2,
  enabled: {
    user_active_no_device: true,
    device_no_owner: true,
    disabled_user_has_device: true,
    device_stale_checkin: true,
    device_missing_from_mdm: true,
    owner_mismatch: true,
    duplicate_device: true
  }
};

export const RULES = [
  {
    key: 'user_active_no_device',
    label: 'Active user without a device',
    severity: 'low',
    entityType: 'person',
    suggestion: 'Assign a device or confirm this person does not need one.',
    detect: userActiveNoDevice
  },
  {
    key: 'device_no_owner',
    label: 'Device reported by MDM without an owner',
    severity: 'medium',
    entityType: 'asset',
    suggestion: 'Assign the device to its user or return it to stock.',
    detect: deviceNoOwner
  },
  {
    key: 'disabled_user_has_device',
    label: 'Disabled account still holds a device',
    severity: 'high',
    entityType: 'asset',
    suggestion: 'Recover the device from the departed user and return it to stock.',
    detect: disabledUserHasDevice
  },
  {
    key: 'device_stale_checkin',
    label: 'Device has not checked in recently',
    severity: 'medium',
    entityType: 'asset',
    suggestion: 'Contact the owner; the device may be lost, broken or unused.',
    detect: deviceStaleCheckin
  },
  {
    key: 'device_missing_from_mdm',
    label: 'Device missing from the last MDM export',
    severity: 'medium',
    entityType: 'asset',
    suggestion: 'Check whether the device was unenrolled, wiped or lost.',
    detect: deviceMissingFromMdm
  },
  {
    key: 'owner_mismatch',
    label: 'MDM reports a different user than the assignment',
    severity: 'medium',
    entityType: 'asset',
    suggestion: 'Confirm who has the device and fix either the MDM or the assignment.',
    detect: ownerMismatch
  },
  {
    key: 'duplicate_device',
    label: 'Possible duplicate device',
    severity: 'low',
    entityType: 'asset',
    suggestion: 'Merge or delete the duplicate record, or confirm the extra device.',
    detect: duplicateDevice
  }
];

export function getRule(key) {
  return RULES.find((rule) => rule.key === key) || null;
}

export function mergeRuleSettings(stored = {}) {
  const value = stored && typeof stored === 'object' ? stored : {};
  const staleDays = Number(value.staleDays);
  const threshold = Number(value.duplicateSameCategoryThreshold);
  return {
    staleDays: Number.isFinite(staleDays) && staleDays > 0 ? Math.floor(staleDays) : DEFAULT_RULE_SETTINGS.staleDays,
    duplicateSameCategoryThreshold: Number.isFinite(threshold) && threshold >= 2
      ? Math.floor(threshold)
      : DEFAULT_RULE_SETTINGS.duplicateSameCategoryThreshold,
    enabled: Object.fromEntries(RULES.map((rule) => [
      rule.key,
      value.enabled?.[rule.key] === undefined ? true : Boolean(value.enabled[rule.key])
    ]))
  };
}

/**
 * Runs every enabled rule over one organization's snapshot. Rules are pure:
 * the same snapshot always yields the same findings and fingerprints, which
 * is what lets the engine upsert instead of duplicating.
 */
export function evaluateRules(snapshot, settings = DEFAULT_RULE_SETTINGS, now = new Date()) {
  const context = buildContext(snapshot, settings, now);
  const findings = [];
  for (const rule of RULES) {
    if (!settings.enabled?.[rule.key]) continue;
    for (const finding of rule.detect(context)) {
      findings.push({
        ruleKey: rule.key,
        severity: finding.severity || rule.severity,
        entityType: rule.entityType,
        entityId: finding.entityId,
        fingerprint: `${rule.key}:${finding.fingerprintKey || finding.entityId}`,
        details: { ...finding.details, suggestion: rule.suggestion }
      });
    }
  }
  return findings;
}

function buildContext(snapshot, settings, now) {
  const people = snapshot.people || [];
  const assets = snapshot.assets || [];
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const peopleByEmail = new Map();
  for (const person of people) {
    for (const email of personEmails(person)) peopleByEmail.set(email, person);
  }
  const assetsByPerson = new Map();
  for (const asset of assets) {
    if (!asset.personId) continue;
    if (!assetsByPerson.has(asset.personId)) assetsByPerson.set(asset.personId, []);
    assetsByPerson.get(asset.personId).push(asset);
  }
  return { people, assets, peopleById, peopleByEmail, assetsByPerson, settings, now };
}

function userActiveNoDevice({ people, assetsByPerson }) {
  return people
    .filter((person) => person.status !== 'inactive' && isFromDirectory(person))
    .filter((person) => !(assetsByPerson.get(person.id) || []).some((asset) => !isRetired(asset)))
    .map((person) => ({
      entityId: person.id,
      details: { person: personSummary(person) }
    }));
}

function deviceNoOwner({ assets }) {
  return assets
    .filter((asset) => !asset.personId && !isRetired(asset) && isFromMdm(asset))
    .filter((asset) => asset.status !== 'in_stock' || reportedUser(asset))
    .map((asset) => ({
      entityId: asset.id,
      details: { asset: assetSummary(asset), reportedUserEmail: reportedUser(asset) }
    }));
}

function disabledUserHasDevice({ assets, peopleById }) {
  return assets
    .filter((asset) => asset.personId && !isRetired(asset))
    .map((asset) => ({ asset, person: peopleById.get(asset.personId) }))
    .filter(({ person }) => person && person.status === 'inactive')
    .map(({ asset, person }) => ({
      entityId: asset.id,
      fingerprintKey: `${asset.id}:${person.id}`,
      details: { asset: assetSummary(asset), person: personSummary(person) }
    }));
}

function deviceStaleCheckin({ assets, settings, now }) {
  const cutoff = now.getTime() - settings.staleDays * DAY_MS;
  return assets
    .filter((asset) => !isRetired(asset) && asset.lastSeenAt)
    .filter((asset) => {
      const seen = Date.parse(asset.lastSeenAt);
      return Number.isFinite(seen) && seen < cutoff;
    })
    .map((asset) => ({
      entityId: asset.id,
      severity: Date.parse(asset.lastSeenAt) < cutoff - settings.staleDays * DAY_MS ? 'high' : undefined,
      details: {
        asset: assetSummary(asset),
        lastSeenAt: asset.lastSeenAt,
        daysSinceSeen: Math.floor((now.getTime() - Date.parse(asset.lastSeenAt)) / DAY_MS),
        staleDays: settings.staleDays
      }
    }));
}

function deviceMissingFromMdm({ assets }) {
  return assets
    .filter((asset) => !isRetired(asset) && asset.importMeta?.missingFromLastImport)
    .map((asset) => ({
      entityId: asset.id,
      details: {
        asset: assetSummary(asset),
        source: asset.importMeta?.source || '',
        missingDetectedAt: asset.importMeta?.missingDetectedAt || ''
      }
    }));
}

function ownerMismatch({ assets, peopleById, peopleByEmail }) {
  const findings = [];
  for (const asset of assets) {
    if (!asset.personId || isRetired(asset)) continue;
    const reported = reportedUser(asset);
    if (!reported) continue;
    const assigned = peopleById.get(asset.personId);
    if (!assigned) continue;
    if (personEmails(assigned).includes(reported)) continue;
    const reportedPerson = peopleByEmail.get(reported);
    findings.push({
      entityId: asset.id,
      fingerprintKey: `${asset.id}:${reported}`,
      details: {
        asset: assetSummary(asset),
        assignedTo: personSummary(assigned),
        reportedUserEmail: reported,
        reportedPerson: reportedPerson ? personSummary(reportedPerson) : null
      }
    });
  }
  return findings;
}

function duplicateDevice({ assets, assetsByPerson, settings }) {
  const findings = [];
  const byExternal = new Map();
  for (const asset of assets) {
    for (const value of Object.values(asset.externalIds || {})) {
      const id = String(value ?? '').trim();
      if (!id) continue;
      if (!byExternal.has(id)) byExternal.set(id, []);
      byExternal.get(id).push(asset);
    }
  }
  for (const [externalId, group] of byExternal) {
    const unique = [...new Map(group.map((asset) => [asset.id, asset])).values()];
    if (unique.length < 2) continue;
    const ids = unique.map((asset) => asset.id).sort();
    findings.push({
      entityId: ids[0],
      fingerprintKey: `external:${externalId}`,
      severity: 'medium',
      details: { reason: 'same_external_id', externalId, assets: unique.map(assetSummary) }
    });
  }

  for (const [personId, owned] of assetsByPerson) {
    const byCategory = new Map();
    for (const asset of owned.filter((item) => !isRetired(item))) {
      const category = String(asset.category || '').trim();
      if (!category) continue;
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push(asset);
    }
    for (const [category, group] of byCategory) {
      if (group.length < settings.duplicateSameCategoryThreshold) continue;
      const ids = group.map((asset) => asset.id).sort();
      findings.push({
        entityId: ids[0],
        fingerprintKey: `person:${personId}:${category.toLowerCase()}`,
        details: { reason: 'same_person_same_category', personId, category, assets: group.map(assetSummary) }
      });
    }
  }
  return findings;
}

function isRetired(asset) {
  return RETIRED.has(String(asset.status || '').toLowerCase());
}

function isFromMdm(asset) {
  const presence = asset.sourcePresence || {};
  return Object.keys(presence).length > 0 || Boolean(asset.importMeta?.source);
}

function isFromDirectory(person) {
  return Object.keys(person.sourcePresence || {}).length > 0;
}

function reportedUser(asset) {
  const presence = asset.sourcePresence || {};
  const latest = Object.values(presence)
    .filter((entry) => entry && entry.reportedUserEmail)
    .sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')))[0];
  return latest ? String(latest.reportedUserEmail).toLowerCase() : '';
}

function personEmails(person) {
  const ids = person.externalIds || {};
  return [person.email, ids.upn, ...(ids.alternateEmails || [])]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
}

function assetSummary(asset) {
  return {
    id: asset.id,
    assetTag: asset.assetTag || '',
    serialNumber: asset.serialNumber || '',
    modelName: asset.modelName || '',
    category: asset.category || '',
    status: asset.status || '',
    lastSeenAt: asset.lastSeenAt || null
  };
}

function personSummary(person) {
  return {
    id: person.id,
    name: [person.firstName, person.lastName].filter(Boolean).join(' ').trim(),
    email: person.email || '',
    department: person.department || '',
    status: person.status || 'active'
  };
}
