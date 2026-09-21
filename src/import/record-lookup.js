const indexCache = new WeakMap();

export function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Each mapper resolves roughly twenty fields per row, with up to ten header
// aliases each. Rebuilding the normalized header index inside every lookup
// makes an import cost `rows x lookups x aliases x columns`, and the column
// count comes straight from the uploaded file, so a wide CSV blocks the event
// loop for every tenant. Building the index once per record keeps it linear.
export function fieldIndex(record) {
  const cached = indexCache.get(record);
  if (cached) return cached;
  const index = new Map();
  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeKey(key);
    const entry = index.get(normalized);
    if (entry) entry.last = value;
    else index.set(normalized, { first: value, last: value });
  }
  indexCache.set(record, index);
  return index;
}
