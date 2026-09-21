/** Normalize MDM / CSV date values to YYYY-MM-DD for storage. */
export function normalizeImportDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    return `${dmy[3]}-${month}-${day}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return '';
}

/** Add calendar months to YYYY-MM-DD (end of warranty from purchase/invoice date). */
export function addMonthsToDate(isoDate, months) {
  const base = normalizeImportDate(isoDate);
  const n = Number(months);
  if (!base || !Number.isFinite(n) || n <= 0) return '';
  const [y, m, d] = base.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCMonth(date.getUTCMonth() + n);
  return date.toISOString().slice(0, 10);
}
