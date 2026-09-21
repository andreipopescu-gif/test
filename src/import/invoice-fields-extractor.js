/**
 * Device purchase / warranty fields extracted from invoice PDF text only.
 * No vendor defaults — empty when the document does not state a value.
 */

import { normalizeImportDate, addMonthsToDate } from './date-utils.js';
import { linesForInvoiceScan } from './pdf-line-normalizer.js';

/**
 * @param {string[]} lines
 * @returns {{ purchaseDate: string, warrantyMonths: number, warrantyUntil: string }}
 */
export function extractDocumentDeviceFields(lines) {
  const scanLines = linesForInvoiceScan(lines);
  const purchaseDate = extractPurchaseDateFromLines(scanLines);
  const warrantyUntil = extractWarrantyUntilFromLines(scanLines);
  const warrantyMonths = warrantyUntil ? 0 : extractWarrantyMonthsFromLines(scanLines);

  return { purchaseDate, warrantyMonths, warrantyUntil };
}

/**
 * @param {string} purchaseDate ISO date
 * @param {number} warrantyMonths
 * @param {string} warrantyUntil ISO date (explicit from PDF)
 */
export function buildDeviceDatesFromExtracted(purchaseDate, warrantyMonths, warrantyUntil = '') {
  const purchase = normalizeImportDate(purchaseDate);
  const explicitEnd = normalizeImportDate(warrantyUntil);
  const months = Number(warrantyMonths);
  const computedEnd = !explicitEnd && purchase && Number.isFinite(months) && months > 0
    ? addMonthsToDate(purchase, months)
    : '';

  return {
    purchaseDate: purchase,
    warrantyUntil: explicitEnd || computedEnd,
    warrantyMonths: explicitEnd ? 0 : (Number.isFinite(months) && months > 0 ? months : 0)
  };
}

/**
 * Row-level months beat document-level; never invent a value.
 * @param {{ warrantyMonths?: number }} parsed
 * @param {{ warrantyMonths?: number, warrantyUntil?: string }} document
 */
export function resolveWarrantyFromExtracted(parsed, document) {
  const rowMonths = Number(parsed?.warrantyMonths);
  if (Number.isFinite(rowMonths) && rowMonths > 0) {
    return { warrantyMonths: rowMonths, warrantyUntil: '' };
  }

  const docEnd = normalizeImportDate(document?.warrantyUntil);
  if (docEnd) return { warrantyMonths: 0, warrantyUntil: docEnd };

  const docMonths = Number(document?.warrantyMonths);
  if (Number.isFinite(docMonths) && docMonths > 0) {
    return { warrantyMonths: docMonths, warrantyUntil: '' };
  }

  return { warrantyMonths: 0, warrantyUntil: '' };
}

function extractPurchaseDateFromLines(lines) {
  for (const line of lines) {
    if (/scadent|scadență|fällig|due\s+date/i.test(line)) continue;

    const m = line.match(
      /(?:data\s+facturii|data\s+factur[aă]|data\s+livr[aă]rii|invoice\s+date|rechnungsdatum|datum)\s*:?\s*(\d{1,2}[./]\d{1,2}[./]\d{4})/i
    );
    if (m) {
      const iso = normalizeImportDate(m[1]);
      if (iso) return iso;
    }

    const m2 = line.match(/datum\s*:?\s*(\d{1,2}[./]\d{1,2}[./]\d{4})/i);
    if (m2) {
      const iso = normalizeImportDate(m2[1]);
      if (iso) return iso;
    }

    const aviz = line.match(/nr\.?\s*:?\s*AI-?\d+\s+din\s+data[^0-9]*(\d{1,2}[./]\d{1,2}[./]\d{4})/i);
    if (aviz) {
      const iso = normalizeImportDate(aviz[1]);
      if (iso) return iso;
    }

    const avizDate = line.match(/din\s+data[^0-9]*(\d{1,2}[./]\d{1,2}[./]\d{4})/i);
    if (avizDate) {
      const iso = normalizeImportDate(avizDate[1]);
      if (iso) return iso;
    }
  }
  return '';
}

function extractWarrantyMonthsFromLines(lines) {
  const candidates = [];

  for (const line of lines) {
    const t = line.trim();
    if (t.length > 300 || t.length < 3) continue;

    let m = t.match(/(\d{1,3})\s*(?:luni|lun[iă]|months?|monate?)\b/i);
    if (m) candidates.push(parseInt(m[1], 10));

    m = t.match(/garantie[^.\n]{0,100}?(\d{1,3})\s*(?:luni|lun[iă])\b/i);
    if (m) candidates.push(parseInt(m[1], 10));

    m = t.match(/(\d{1,3})\s*(?:luni|lun[iă])\s+(?:de\s+)?garantie/i);
    if (m) candidates.push(parseInt(m[1], 10));

    m = t.match(/garantie[^.\n]{0,80}?(\d{1,2})\s*ani\b/i);
    if (m) candidates.push(parseInt(m[1], 10) * 12);

    m = t.match(/(\d{1,3})\s*(?:monate?|months?)\s+(?:gew[aä]hr|garantie|warranty)/i);
    if (m) candidates.push(parseInt(m[1], 10));

    m = t.match(/(?:gew[aä]hrleistung|garantiezeit)\s*:?\s*(\d{1,3})\s*(?:monate?|months?)/i);
    if (m) candidates.push(parseInt(m[1], 10));
  }

  const valid = candidates.filter((n) => n >= 1 && n <= 120);
  if (!valid.length) return 0;
  return valid[0];
}

function extractWarrantyUntilFromLines(lines) {
  for (const line of lines) {
    const m = line.match(
      /(?:garantie|warranty|gew[aä]hrleistung)[^.\n]{0,80}?(?:p[aâ]n[aă]|until|bis|la|pana)\s*(?:la|at)?\s*:?\s*(\d{1,2}[./]\d{1,2}[./]\d{4})/i
    );
    if (m) {
      const iso = normalizeImportDate(m[1]);
      if (iso) return iso;
    }

    const m2 = line.match(/(?:valabilitate|valabil[aă])\s+(?:garantie\s+)?(?:p[aâ]n[aă]\s+la\s+)?(\d{1,2}[./]\d{1,2}[./]\d{4})/i);
    if (m2) {
      const iso = normalizeImportDate(m2[1]);
      if (iso) return iso;
    }
  }
  return '';
}
