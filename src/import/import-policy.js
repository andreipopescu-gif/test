/**
 * Per-request import configuration. Shared import modules used to hold
 * exclusions and identity groups in module-level `let` bindings, which is fine
 * for the single-tenant offline app but unsafe on a multi-tenant host: two
 * concurrent imports from different organizations would race on the same
 * globals. Callers pass a frozen policy instead; the runtime setters remain as
 * a shim for the offline app.
 */

import {
  DEFAULT_EXCLUDED_EMAILS,
  DEFAULT_EXCLUDED_NAME_RULES,
  DEFAULT_IDENTITY_GROUPS
} from '../settings/defaults.js';

export function createImportPolicy({
  excludedEmails = [],
  excludedNameRules = [],
  identityGroups = [],
  modelOverrides = {}
} = {}) {
  return Object.freeze({
    excludedEmails: Object.freeze(
      [...new Set((excludedEmails || []).map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean))]
    ),
    excludedNameRules: Object.freeze(
      (excludedNameRules || [])
        .map((rule, index) => Object.freeze({
          id: String(rule?.id || `rule-${index}`),
          tokens: Object.freeze(
            (rule?.tokens || []).map((token) => String(token ?? '').trim().toLowerCase()).filter(Boolean)
          )
        }))
        .filter((rule) => rule.tokens.length)
    ),
    identityGroups: Object.freeze(
      (identityGroups || []).map((group) => Object.freeze({
        emails: Object.freeze(
          [...new Set((group?.emails || []).map((email) => String(email ?? '').trim().toLowerCase()).filter(Boolean))]
        ),
        firstName: String(group?.firstName || '').trim(),
        lastName: String(group?.lastName || '').trim()
      }))
    ),
    modelOverrides: Object.freeze({ ...(modelOverrides || {}) })
  });
}

export function emptyImportPolicy() {
  return createImportPolicy();
}

export function defaultImportPolicy() {
  return createImportPolicy({
    excludedEmails: DEFAULT_EXCLUDED_EMAILS,
    excludedNameRules: DEFAULT_EXCLUDED_NAME_RULES,
    identityGroups: DEFAULT_IDENTITY_GROUPS
  });
}

// Offline-app shim. SaaS code must never write this; it passes a policy per request.
let runtimePolicy = defaultImportPolicy();

export function getRuntimeImportPolicy() {
  return runtimePolicy;
}

export function setRuntimeImportPolicy(policy) {
  runtimePolicy = policy || emptyImportPolicy();
}
