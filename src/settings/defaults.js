/**
 * Built-in defaults for app settings (seeded into db.settings on first run).
 * Runtime edits live in app.db.json → settings and override/extend these.
 */

export const DEFAULT_HANDOVER_OPERATORS = ['Andrei Popescu', 'Dan Istrate'];

/** Email substrings / full addresses to skip on user import (in addition to name patterns). */
export const DEFAULT_EXCLUDED_EMAILS = [
  'sg@tchibo.onmicrosoft.com',
  'marian.ene@tchibo.bg',
  'notificari@tchibo.ro'
];

/** Name-token pairs: skip if haystack contains all tokens. */
export const DEFAULT_EXCLUDED_NAME_RULES = [
  { id: 'albu-costin', tokens: ['albu', 'costin'] },
  { id: 'cojemeachin-denis', tokens: ['cojemeachin', 'denis'] },
  { id: 'igor-pogorevici', tokens: ['pogorevici', 'igor'] },
  { id: 'luminita-klein', tokens: ['luminita', 'klein'] },
  { id: 'tudorache-creola', tokens: ['tudorache', 'creola'] },
  { id: 'stefan-gaydarzhiev', tokens: ['gaydarzhiev', 'stefan'] }
];

export const DEFAULT_IDENTITY_GROUPS = [
  {
    emails: ['gabriel.mitincu@tchibo.ro', 'gabriel.onea@tchibo.ro'],
    firstName: 'Gabriel',
    lastName: 'Mitincu'
  },
  {
    emails: ['crina.zamfir@tchibo.ro', 'lucretianicoleta.zamfir@tchibo.ro'],
    firstName: 'Lucretia Nicoleta',
    lastName: 'Zamfir'
  },
  {
    emails: ['edwin.straub@tchibo-external.com', 'edwin.straub1@tchibo-external.com'],
    firstName: 'Edwin',
    lastName: 'Straub'
  }
];

export function defaultSettings() {
  return {
    handoverOperators: [...DEFAULT_HANDOVER_OPERATORS],
    excludedEmails: [...DEFAULT_EXCLUDED_EMAILS],
    excludedNameRules: DEFAULT_EXCLUDED_NAME_RULES.map((rule) => ({ ...rule, tokens: [...rule.tokens] })),
    identityGroups: DEFAULT_IDENTITY_GROUPS.map((group) => ({
      emails: [...group.emails],
      firstName: group.firstName || '',
      lastName: group.lastName || ''
    })),
    /** serialNumber (lower) → modelId */
    modelOverrides: {},
    updatedAt: ''
  };
}
