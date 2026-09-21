/**
 * Canonical device model label used by dashboard counts and the UI list filter.
 * Keep browser `displayModelName` in sync with this helper.
 */
export function formatAssetModelLabel(model = {}, brand = null, category = null) {
  const isPhone =
    model?.deviceType === 'Telefon' ||
    category?.name === 'Telefon';
  if (isPhone) {
    return String(model?.name || 'Telefon').trim() || 'Telefon';
  }
  return [brand?.name, model?.name, model?.generation]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Necunoscut';
}

/** Local calendar YYYY-MM-DD (avoids UTC midnight off-by-one on warranty dates). */
export function localDateYmd(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isWarrantyExpiringWithinDays(warrantyUntil, days = 30, now = new Date()) {
  const end = String(warrantyUntil ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  const today = localDateYmd(now);
  const soon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const until = localDateYmd(soon);
  return end >= today && end <= until;
}
