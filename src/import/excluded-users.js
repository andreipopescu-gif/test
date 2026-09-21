/**
 * Users that must never be created/updated from Intune or Entra imports.
 * Runtime lists come from app settings (seeded with defaults).
 */

import { DEFAULT_EXCLUDED_EMAILS, DEFAULT_EXCLUDED_NAME_RULES } from '../settings/defaults.js';

let runtimeExcludedEmails = [...DEFAULT_EXCLUDED_EMAILS];
let runtimeExcludedNameRules = DEFAULT_EXCLUDED_NAME_RULES.map((rule) => ({
  id: rule.id,
  tokens: [...rule.tokens]
}));

export function setRuntimeExcludedUsers({ emails, nameRules } = {}) {
  runtimeExcludedEmails = Array.isArray(emails) && emails.length
    ? emails.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean)
    : [...DEFAULT_EXCLUDED_EMAILS];
  runtimeExcludedNameRules = Array.isArray(nameRules) && nameRules.length
    ? nameRules.map((rule, index) => ({
        id: rule.id || `rule-${index}`,
        tokens: (rule.tokens || []).map((token) => String(token ?? '').trim().toLowerCase()).filter(Boolean)
      })).filter((rule) => rule.tokens.length)
    : DEFAULT_EXCLUDED_NAME_RULES.map((rule) => ({ id: rule.id, tokens: [...rule.tokens] }));
}

export function shouldSkipImportedUser(person = {}) {
  const haystack = normalizeIdentity([
    person.displayName,
    person.firstName,
    person.lastName,
    person.email,
    person.externalIds?.upn,
    person.upn
  ].filter(Boolean).join(' '));
  if (!haystack) return false;

  for (const email of runtimeExcludedEmails) {
    if (email && haystack.includes(email)) return true;
  }
  if (/(^|[\s,;@._-])notificari([\s,;@._-]|$)/.test(haystack)) return true;

  return runtimeExcludedNameRules.some((rule) =>
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
