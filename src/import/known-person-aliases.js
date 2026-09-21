/**
 * Runtime identity groups — seeded from settings, used by person-email-alias helpers.
 */
import { DEFAULT_IDENTITY_GROUPS } from '../settings/defaults.js';

let runtimeIdentityGroups = DEFAULT_IDENTITY_GROUPS.map((group) => ({
  emails: [...group.emails],
  firstName: group.firstName || '',
  lastName: group.lastName || ''
}));

/**
 * `useDefaults: false` clears the built-in company-specific alias groups, which
 * multi-tenant hosts need so identities are never merged across customers.
 */
export function setRuntimeIdentityGroups(groups, { useDefaults = true } = {}) {
  if (!Array.isArray(groups) || !groups.length) {
    runtimeIdentityGroups = useDefaults
      ? DEFAULT_IDENTITY_GROUPS.map((group) => ({
          emails: [...group.emails],
          firstName: group.firstName || '',
          lastName: group.lastName || ''
        }))
      : [];
    return;
  }
  runtimeIdentityGroups = groups.map((group) => ({
    emails: [...(group.emails || [])],
    firstName: group.firstName || '',
    lastName: group.lastName || ''
  }));
}

export function getIdentityGroups() {
  return runtimeIdentityGroups;
}

/** @deprecated use getIdentityGroups — kept for older imports */
export const knownPersonIdentityGroups = DEFAULT_IDENTITY_GROUPS;

export function normalizeIdentityEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function findKnownPersonIdentityGroup(email) {
  const target = normalizeIdentityEmail(email);
  if (!target) return null;
  return getIdentityGroups().find((group) =>
    (group.emails || []).some((item) => normalizeIdentityEmail(item) === target)
  ) ?? null;
}

export function emailsAreKnownSamePerson(emailA, emailB) {
  const a = normalizeIdentityEmail(emailA);
  const b = normalizeIdentityEmail(emailB);
  if (!a || !b) return false;
  if (a === b) return true;
  const group = findKnownPersonIdentityGroup(a);
  if (!group) return false;
  return (group.emails || []).some((item) => normalizeIdentityEmail(item) === b);
}

export function preferKnownCanonicalEmail(emailA, emailB) {
  const group = findKnownPersonIdentityGroup(emailA) || findKnownPersonIdentityGroup(emailB);
  if (!group?.emails?.length) return '';
  if (!emailsAreKnownSamePerson(emailA, emailB) && emailA && emailB) return '';
  return normalizeIdentityEmail(group.emails[0]);
}

export function preferredIdentityNames(email) {
  const group = findKnownPersonIdentityGroup(email);
  if (!group) return null;
  if (!group.firstName && !group.lastName) return null;
  return {
    firstName: group.firstName || '',
    lastName: group.lastName || ''
  };
}

export function personEmailsInKnownGroup(person, emailOrUpn) {
  const target = normalizeIdentityEmail(emailOrUpn);
  if (!target) return false;
  const group = findKnownPersonIdentityGroup(target);
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
