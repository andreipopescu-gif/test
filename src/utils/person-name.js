const knownGivenNames = [
  'adina', 'adrian', 'adriana', 'alin', 'alexandra', 'alexandru', 'andra', 'andrei',
  'angela', 'bogdan', 'constantin', 'cosmin', 'cristian', 'cristina', 'cristinel',
  'daniel', 'daniela', 'david', 'diana', 'elena', 'florin', 'florentin', 'gabriel',
  'george', 'gheorghe', 'ioan', 'ioana', 'ionela', 'ionut', 'laurentiu', 'lorena',
  'lucretia', 'maria', 'marian', 'mihaela', 'mihai', 'nicolae', 'nicoleta', 'paul',
  'radu', 'razvan', 'rodica', 'stefan', 'teodor', 'valentin', 'vlad'
];

export function formatPersonDisplayName(person) {
  const raw = [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();
  return titleCasePersonName(raw) || '-';
}

export function titleCasePersonName(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/[A-ZĂÂÎȘȚ]/.test(text.slice(1)) && !text.split(/\s+/).some(canSplitKnownGivenName)) return text;
  return text
    .split(/\s+/)
    .flatMap(splitKnownGivenName)
    .map((part) => part.charAt(0).toLocaleUpperCase('ro-RO') + part.slice(1).toLocaleLowerCase('ro-RO'))
    .join(' ');
}

/**
 * Parse Entra/Intune display names into structured fields.
 * Examples:
 * - "Popescu, Angela (IT)" → Angela / Popescu / IT
 * - "Fan, Angela Elena (SAT)" → Angela Elena / Fan / SAT
 * - "Angela Elena Popescu" → Angela Elena / Popescu
 */
export function parsePersonDisplayName(value) {
  let text = String(value ?? '').replace(/@.+$/, '').trim();
  if (!text) {
    return { firstName: 'Necunoscut', lastName: '-', department: '' };
  }

  let department = '';
  const paren = text.match(/\(([^)]+)\)\s*$/);
  if (paren) {
    department = paren[1].trim();
    text = text.slice(0, paren.index).trim();
  }

  text = text.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (text.includes(',')) {
    const [lastPart, ...rest] = text.split(',');
    const given = rest.join(',').trim();
    return {
      firstName: titleCasePersonName(given || 'Necunoscut'),
      lastName: titleCasePersonName(lastPart.replace(/,+$/, '').trim() || '-'),
      department
    };
  }

  const parts = titleCasePersonName(text).split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return {
      firstName: parts[0] || 'Necunoscut',
      lastName: '-',
      department
    };
  }

  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
    department
  };
}

export function looksLikeMalformedPersonName(firstName, lastName) {
  const first = String(firstName ?? '');
  const last = String(lastName ?? '');
  if (/,\s*$/.test(first) || first.includes(',')) return true;
  if (/\([^)]+\)/.test(last) || /\([^)]+\)/.test(first)) return true;
  return false;
}

/** Prefer cleaner / more complete names when merging imports. */
export function preferPersonName(existing, incoming) {
  const existingScore = nameQualityScore(existing?.firstName, existing?.lastName);
  const incomingScore = nameQualityScore(incoming?.firstName, incoming?.lastName);
  if (incomingScore > existingScore) {
    return {
      firstName: incoming.firstName,
      lastName: incoming.lastName
    };
  }
  if (incomingScore < existingScore) {
    return {
      firstName: existing.firstName,
      lastName: existing.lastName
    };
  }
  const existingLen = `${existing?.firstName || ''} ${existing?.lastName || ''}`.trim().length;
  const incomingLen = `${incoming?.firstName || ''} ${incoming?.lastName || ''}`.trim().length;
  if (incomingLen > existingLen) {
    return { firstName: incoming.firstName, lastName: incoming.lastName };
  }
  return { firstName: existing.firstName, lastName: existing.lastName };
}

export function repairPersonNameFields(person) {
  if (!person) return false;
  let changed = false;
  const first = String(person.firstName ?? '');
  const last = String(person.lastName ?? '');
  if (looksLikeMalformedPersonName(first, last)) {
    const parsed = parsePersonDisplayName(`${first} ${last}`.replace(/\s+/g, ' ').trim());
    if (parsed.firstName && parsed.firstName !== first) {
      person.firstName = parsed.firstName;
      changed = true;
    }
    if (parsed.lastName && parsed.lastName !== last) {
      person.lastName = parsed.lastName;
      changed = true;
    }
    if (parsed.department && !String(person.department || '').trim()) {
      person.department = parsed.department;
      changed = true;
    }
  } else if (!String(person.department || '').trim()) {
    const fromLast = last.match(/\(([^)]+)\)\s*$/);
    if (fromLast) {
      person.department = fromLast[1].trim();
      person.lastName = titleCasePersonName(last.replace(/\([^)]+\)\s*$/, '').trim() || person.lastName);
      changed = true;
    }
  }
  return changed;
}

function nameQualityScore(firstName, lastName) {
  let score = 0;
  const first = String(firstName ?? '').trim();
  const last = String(lastName ?? '').trim();
  if (!first || first === 'Necunoscut') score -= 5;
  if (!last || last === '-') score -= 5;
  if (looksLikeMalformedPersonName(first, last)) score -= 10;
  if (first.includes(',') || last.includes(',')) score -= 8;
  if (/\([^)]+\)/.test(first) || /\([^)]+\)/.test(last)) score -= 8;
  score += Math.min(first.split(/\s+/).filter(Boolean).length, 3);
  score += last && last !== '-' ? 2 : 0;
  return score;
}

function splitKnownGivenName(value) {
  const normalized = String(value ?? '').toLocaleLowerCase('ro-RO');
  if (normalized.length < 8 || knownGivenNames.includes(normalized)) return [value];
  const firstMatch = knownGivenNames
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((name) => normalized.startsWith(name));
  if (!firstMatch) return [value];
  const remainder = normalized.slice(firstMatch.length);
  if (!knownGivenNames.includes(remainder)) return [value];
  return [firstMatch, remainder];
}

function canSplitKnownGivenName(value) {
  return splitKnownGivenName(value).length > 1;
}
