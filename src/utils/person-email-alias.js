/**
 * Detect Entra vs Intune email aliases for the same person.
 * Example: angela.popescu@tchibo.ro ↔ angelaelena.popescu@tchibo.ro
 * Also respects explicit name-change links from known-person-aliases.
 */

import {
  emailsAreKnownSamePerson,
  findKnownPersonIdentityGroup,
  normalizeIdentityEmail,
  preferKnownCanonicalEmail,
  preferredIdentityNames
} from '../import/known-person-aliases.js';

function cleanName(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function parseEmailIdentity(email) {
  const full = String(email ?? '').trim().toLowerCase();
  if (!full || !full.includes('@')) return null;
  const [local, domain] = full.split('@');
  if (!local || !domain) return null;
  const parts = local.split('.').filter(Boolean);
  if (parts.length < 2) {
    return { full, local, domain, given: local.replace(/[^a-z0-9]/gi, ''), family: '' };
  }
  const family = parts[parts.length - 1].replace(/[^a-z0-9]/gi, '');
  const given = parts.slice(0, -1).join('').replace(/[^a-z0-9]/gi, '');
  return { full, local, domain, given, family };
}

export function emailsArePersonAliases(emailA, emailB) {
  const a = parseEmailIdentity(emailA);
  const b = parseEmailIdentity(emailB);
  if (!a || !b) return false;
  if (a.full === b.full) return true;
  if (a.domain !== b.domain) return false;
  if (!a.family || !b.family || a.family !== b.family) return false;
  if (!a.given || !b.given) return false;
  if (a.given === b.given) return true;
  // angela vs angelaelena (middle name glued into local-part)
  if (a.given.startsWith(b.given) || b.given.startsWith(a.given)) {
    const shorter = a.given.length <= b.given.length ? a.given : b.given;
    const longer = a.given.length > b.given.length ? a.given : b.given;
    // Require meaningful prefix (at least 4 chars) to avoid false positives like ion/ionut
    return shorter.length >= 4 && longer.startsWith(shorter);
  }
  return false;
}

/**
 * edwin.straub@… ↔ edwin.straub1@… (Entra collision / temp enrollment suffix)
 */
export function emailsAreDigitSuffixAliases(emailA, emailB) {
  const a = parseEmailIdentity(emailA);
  const b = parseEmailIdentity(emailB);
  if (!a || !b) return false;
  if (a.full === b.full) return true;
  if (a.domain !== b.domain) return false;
  const baseA = a.local.replace(/\d+$/, '');
  const baseB = b.local.replace(/\d+$/, '');
  if (!baseA || baseA !== baseB) return false;
  return a.local !== baseA || b.local !== baseB;
}

/** Prefer first.last over firstmiddle.last when they are aliases. */
export function preferCanonicalEmail(emailA, emailB) {
  const known = preferKnownCanonicalEmail(emailA, emailB);
  if (known) return known;
  const a = parseEmailIdentity(emailA);
  const b = parseEmailIdentity(emailB);
  if (!a && !b) return '';
  if (!a) return b.full;
  if (!b) return a.full;

  if (emailsAreDigitSuffixAliases(a.full, b.full)) {
    const aHasDigit = /\d+$/.test(a.local);
    const bHasDigit = /\d+$/.test(b.local);
    if (aHasDigit !== bHasDigit) return aHasDigit ? b.full : a.full;
    return a.local.length <= b.local.length ? a.full : b.full;
  }

  if (!emailsArePersonAliases(a.full, b.full) && !emailsAreKnownSamePerson(a.full, b.full)) {
    return a.full;
  }
  if (emailsAreKnownSamePerson(a.full, b.full)) {
    return preferKnownCanonicalEmail(a.full, b.full) || a.full;
  }
  if (a.given.length !== b.given.length) {
    return a.given.length < b.given.length ? a.full : b.full;
  }
  return a.full.length <= b.full.length ? a.full : b.full;
}

export function collectPersonEmails(person) {
  const ids = person?.externalIds ?? {};
  return [
    person?.email,
    ids.upn,
    ...(Array.isArray(ids.alternateEmails) ? ids.alternateEmails : [])
  ]
    .map((value) => String(value ?? '').trim().toLowerCase())
    .filter(Boolean);
}

export function personMatchesEmailAlias(person, emailOrUpn) {
  const target = String(emailOrUpn ?? '').trim().toLowerCase();
  if (!target) return false;
  return collectPersonEmails(person).some((candidate) =>
    candidate === target ||
    emailsArePersonAliases(candidate, target) ||
    emailsAreDigitSuffixAliases(candidate, target) ||
    emailsAreKnownSamePerson(candidate, target)
  );
}

export function emailsLinkedForSamePerson(emailA, emailB) {
  return Boolean(
    emailA &&
    emailB &&
    (
      normalizeIdentityEmail(emailA) === normalizeIdentityEmail(emailB) ||
      emailsArePersonAliases(emailA, emailB) ||
      emailsAreDigitSuffixAliases(emailA, emailB) ||
      emailsAreKnownSamePerson(emailA, emailB)
    )
  );
}

/** Apply curated name after identity merge (e.g. Onea → Mitincu). */
export function applyPreferredIdentityNames(person) {
  if (!person) return false;
  const names = preferredIdentityNames(person.email) ||
    preferredIdentityNames(person.externalIds?.upn) ||
    (person.externalIds?.alternateEmails || []).map(preferredIdentityNames).find(Boolean);
  if (!names) return false;
  let changed = false;
  if (names.firstName && person.firstName !== names.firstName) {
    person.firstName = names.firstName;
    changed = true;
  }
  if (names.lastName && person.lastName !== names.lastName) {
    person.lastName = names.lastName;
    changed = true;
  }
  return changed;
}

/** Guard against false alias merges (e.g. Alex vs Alexandru) when names clearly differ. */
export function peopleNamesLikelySame(personA, personB) {
  const lastA = cleanName(personA?.lastName).replace(/\d+$/, '');
  const lastB = cleanName(personB?.lastName).replace(/\d+$/, '');
  if (lastA && lastB && lastA !== lastB) return false;

  const firstA = cleanName(personA?.firstName).replace(/\d+$/, '');
  const firstB = cleanName(personB?.firstName).replace(/\d+$/, '');
  if (!firstA || !firstB) return true;
  if (firstA === firstB) return true;

  const compactA = firstA.replace(/\s+/g, '');
  const compactB = firstB.replace(/\s+/g, '');
  if (compactA === compactB) return true;

  const headA = firstA.split(/\s+/)[0];
  const headB = firstB.split(/\s+/)[0];
  if (headA === headB) return true;
  if (headA.startsWith(headB) || headB.startsWith(headA)) {
    const shorter = headA.length <= headB.length ? headA : headB;
    return shorter.length >= 4;
  }
  return false;
}

export function personProfileScore(person) {
  let score = 0;
  const ids = person?.externalIds ?? {};
  if (String(ids.entraObjectId ?? '').trim()) score += 100;
  if (String(person?.department ?? '').trim()) score += 20;
  if (String(person?.role ?? '').trim()) score += 20;
  if (String(person?.phone ?? '').trim()) score += 5;
  if (String(person?.location ?? '').trim()) score += 5;
  if (String(person?.manager ?? '').trim()) score += 5;
  const identity = parseEmailIdentity(person?.email || ids.upn);
  if (identity?.given) score += Math.max(0, 40 - identity.given.length);
  if (identity?.local && !/\d+$/.test(identity.local)) score += 15;
  const group = findKnownPersonIdentityGroup(person?.email || ids.upn);
  if (group?.emails?.[0] && normalizeIdentityEmail(person?.email || ids.upn) === normalizeIdentityEmail(group.emails[0])) {
    score += 50;
  }
  return score;
}

/**
 * Merge email/UPN candidates onto a person: keep shortest alias as primary,
 * store the rest in externalIds.alternateEmails.
 */
export function absorbPersonEmails(person, incomingEmails = []) {
  person.externalIds ??= {};
  const previous = collectPersonEmails(person);
  const originals = [
    person.email,
    person.externalIds.upn,
    ...(Array.isArray(person.externalIds.alternateEmails) ? person.externalIds.alternateEmails : []),
    ...incomingEmails
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  const byLower = new Map();
  for (const value of originals) {
    const lower = value.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, value);
  }

  const all = [...byLower.keys()];
  if (!all.length) return;

  let primaryLower = previous[0] || all[0];
  for (const candidate of all) {
    if (
      candidate === primaryLower ||
      emailsArePersonAliases(primaryLower, candidate) ||
      emailsAreDigitSuffixAliases(primaryLower, candidate) ||
      emailsAreKnownSamePerson(primaryLower, candidate)
    ) {
      primaryLower = preferCanonicalEmail(primaryLower, candidate);
    }
  }

  // If any address belongs to a known identity group, force that group's preferred email.
  for (const candidate of all) {
    const group = findKnownPersonIdentityGroup(candidate);
    if (!group?.emails?.[0]) continue;
    const preferred = normalizeIdentityEmail(group.emails[0]);
    if (all.includes(preferred) || emailsAreKnownSamePerson(candidate, preferred)) {
      primaryLower = preferred;
      if (!byLower.has(preferred)) byLower.set(preferred, group.emails[0]);
      break;
    }
  }

  const alternates = [];
  for (const candidate of all) {
    if (candidate === primaryLower) continue;
    if (
      emailsArePersonAliases(primaryLower, candidate) ||
      emailsAreDigitSuffixAliases(primaryLower, candidate) ||
      emailsAreKnownSamePerson(primaryLower, candidate) ||
      previous.includes(candidate)
    ) {
      alternates.push(byLower.get(candidate) || candidate);
    }
  }

  person.email = byLower.get(primaryLower) || primaryLower;
  const currentUpn = String(person.externalIds.upn ?? '').trim().toLowerCase();
  if (
    !currentUpn ||
    emailsArePersonAliases(currentUpn, primaryLower) ||
    emailsAreDigitSuffixAliases(currentUpn, primaryLower) ||
    emailsAreKnownSamePerson(currentUpn, primaryLower) ||
    currentUpn === primaryLower
  ) {
    person.externalIds.upn = person.email;
  }
  person.externalIds.alternateEmails = [...new Set(alternates.map((value) => value.toLowerCase()))]
    .filter((value) => value !== primaryLower)
    .map((value) => byLower.get(value) || value);
  applyPreferredIdentityNames(person);
}
