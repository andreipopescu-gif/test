/**
 * Users that must never be created/updated from Intune or Entra imports.
 * Prefer an explicit ImportPolicy; the module-level lists are only a shim for
 * the offline single-tenant app, which still calls setRuntimeExcludedUsers().
 */

import {
  createImportPolicy,
  defaultImportPolicy,
  emptyImportPolicy,
  getRuntimeImportPolicy,
  setRuntimeImportPolicy
} from './import-policy.js';

/**
 * `useDefaults: false` drops the built-in company-specific lists. Multi-tenant
 * hosts must opt out so one customer's exclusions never hide another's people.
 * Prefer createImportPolicy() + shouldSkipImportedUser(person, policy).
 */
export function setRuntimeExcludedUsers({ emails, nameRules, useDefaults = true } = {}) {
  const current = getRuntimeImportPolicy();
  const base = useDefaults ? defaultImportPolicy() : emptyImportPolicy();
  setRuntimeImportPolicy(createImportPolicy({
    excludedEmails: Array.isArray(emails) && emails.length ? emails : base.excludedEmails,
    excludedNameRules: Array.isArray(nameRules) && nameRules.length ? nameRules : base.excludedNameRules,
    identityGroups: current.identityGroups,
    modelOverrides: current.modelOverrides
  }));
}

export function shouldSkipImportedUser(person = {}, policy = getRuntimeImportPolicy()) {
  const haystack = normalizeIdentity([
    person.displayName,
    person.firstName,
    person.lastName,
    person.email,
    person.externalIds?.upn,
    person.upn
  ].filter(Boolean).join(' '));
  if (!haystack) return false;

  for (const email of policy.excludedEmails) {
    if (email && haystack.includes(email)) return true;
  }
  if (/(^|[\s,;@._-])notificari([\s,;@._-]|$)/.test(haystack)) return true;

  return policy.excludedNameRules.some((rule) =>
    rule.tokens.every((token) => haystack.includes(token))
  );
}

/**
 * Detect Microsoft Teams Room devices for Romania / Bulgaria.
 * Returns 'RO' | 'BG' | ''.
 */
export function detectMtrRegion({
  assetTag = '',
  deviceName = '',
  email = '',
  userName = '',
  groupTag = '',
  upn = ''
} = {}) {
  const tag = String(groupTag || '').trim();
  const text = [assetTag, deviceName, email, userName, upn, tag].filter(Boolean).join(' ');
  const compact = text.replace(/[\s_-]+/g, '').toLowerCase();

  if (/mtr[\s_-]*bg/i.test(tag) || /mtrbg/i.test(tag.replace(/[\s_-]+/g, ''))) return 'BG';
  if (/mtr[\s_-]*ro/i.test(tag) || /mtrro/i.test(tag.replace(/[\s_-]+/g, ''))) return 'RO';

  if (/ro[_-]?room/i.test(text) || compact.includes('roroom')) return 'RO';
  if (/bg[_-]?room/i.test(text) || compact.includes('bgroom')) return 'BG';

  return '';
}

export function mtrCategoryName(region) {
  if (region === 'RO') return 'MTR RO';
  if (region === 'BG') return 'MTR BG';
  return '';
}

function normalizeIdentity(value) {
  return String(value ?? '')
    .toLocaleLowerCase('ro-RO')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[,()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
