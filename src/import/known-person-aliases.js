/**
 * Identity groups — prefer an explicit ImportPolicy. The module-level list is
 * only a shim for the offline single-tenant app.
 */
import {
  createImportPolicy,
  defaultImportPolicy,
  emptyImportPolicy,
  getRuntimeImportPolicy,
  setRuntimeImportPolicy
} from './import-policy.js';

/**
 * `useDefaults: false` clears the built-in company-specific alias groups, which
 * multi-tenant hosts need so identities are never merged across customers.
 * Prefer createImportPolicy() and pass the policy to the helpers below.
 */
export function setRuntimeIdentityGroups(groups, { useDefaults = true } = {}) {
  const current = getRuntimeImportPolicy();
  const base = useDefaults ? defaultImportPolicy() : emptyImportPolicy();
  const nextGroups = Array.isArray(groups) && groups.length ? groups : base.identityGroups;
  setRuntimeImportPolicy(createImportPolicy({
    excludedEmails: current.excludedEmails,
    excludedNameRules: current.excludedNameRules,
    identityGroups: nextGroups,
    modelOverrides: current.modelOverrides
  }));
}

export function getIdentityGroups(policy = getRuntimeImportPolicy()) {
  return resolvePolicy(policy).identityGroups;
}

/** @deprecated use getIdentityGroups — kept for older imports */
export { DEFAULT_IDENTITY_GROUPS as knownPersonIdentityGroups } from '../settings/defaults.js';

export function normalizeIdentityEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function resolvePolicy(policy) {
  // Array#map passes the index as the second argument. Call sites that used
  // `.map(preferredIdentityNames)` relied on the old single-argument helpers
  // ignoring it; treat a non-object as "use the runtime policy".
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return getRuntimeImportPolicy();
  }
  return policy;
}

export function findKnownPersonIdentityGroup(email, policy = getRuntimeImportPolicy()) {
  const target = normalizeIdentityEmail(email);
  if (!target) return null;
  return getIdentityGroups(resolvePolicy(policy)).find((group) =>
    (group.emails || []).some((item) => normalizeIdentityEmail(item) === target)
  ) ?? null;
}

export function emailsAreKnownSamePerson(emailA, emailB, policy = getRuntimeImportPolicy()) {
  const a = normalizeIdentityEmail(emailA);
  const b = normalizeIdentityEmail(emailB);
  if (!a || !b) return false;
  if (a === b) return true;
  const group = findKnownPersonIdentityGroup(a, policy);
  if (!group) return false;
  return (group.emails || []).some((item) => normalizeIdentityEmail(item) === b);
}

export function preferKnownCanonicalEmail(emailA, emailB, policy = getRuntimeImportPolicy()) {
  const group = findKnownPersonIdentityGroup(emailA, policy) || findKnownPersonIdentityGroup(emailB, policy);
  if (!group?.emails?.length) return '';
  if (!emailsAreKnownSamePerson(emailA, emailB, policy) && emailA && emailB) return '';
  return normalizeIdentityEmail(group.emails[0]);
}

export function preferredIdentityNames(email, policy = getRuntimeImportPolicy()) {
  const group = findKnownPersonIdentityGroup(email, policy);
  if (!group) return null;
  if (!group.firstName && !group.lastName) return null;
  return {
    firstName: group.firstName || '',
    lastName: group.lastName || ''
  };
}

export function personEmailsInKnownGroup(person, emailOrUpn, policy = getRuntimeImportPolicy()) {
  const target = normalizeIdentityEmail(emailOrUpn);
  if (!target) return false;
  const group = findKnownPersonIdentityGroup(target, policy);
  if (!group) return false;
  const personEmails = [
    person?.email,
    person?.externalIds?.upn,
    ...(person?.externalIds?.alternateEmails ?? [])
  ].map(normalizeIdentityEmail).filter(Boolean);
  return personEmails.some((email) =>
    (group.emails || []).some((item) => normalizeIdentityEmail(item) === email)
  );
}
