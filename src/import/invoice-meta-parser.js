/**
 * Extract invoice header metadata from PDF text (Romanian + German suppliers).
 */

import { extractLinesFromPdf } from './invoice-pdf-parser.js';
import { normalizeImportDate } from './date-utils.js';
import { linesForInvoiceScan } from './pdf-line-normalizer.js';

const KNOWN_VENDORS = [
  { re: /cancom\s+romania/i, label: 'Cancom Romania' },
  { re: /chrome\s+computers/i, label: 'Chrome Computers' },
  { re: /\bfks\s+it\b/i, label: 'FKS IT GmbH' },
  { re: /\baltex\b/i, label: 'Altex' },
  { re: /\bemag\b/i, label: 'eMAG' },
  { re: /\bflanco\b/i, label: 'Flanco' },
  { re: /\bpc\s*garage\b/i, label: 'PC Garage' }
];

/**
 * @param {Buffer} buffer
 * @returns {{ invoiceNumber: string, invoiceDate: string, vendor: string, amount: string }}
 */
export function extractInvoiceMetaFromPdf(buffer) {
  const lines = extractLinesFromPdf(buffer);
  return extractInvoiceMetaFromLines(lines);
}

/**
 * @param {string[]} lines
 */
export function extractInvoiceMetaFromLines(lines) {
  const scanLines = linesForInvoiceScan(lines);
  const joined = scanLines.join(' ');
  return {
    invoiceNumber: extractInvoiceNumber(scanLines, joined),
    invoiceDate: extractInvoiceDate(scanLines),
    vendor: extractVendor(scanLines, joined),
    amount: extractInvoiceAmount(scanLines, joined)
  };
}

/** User fields win; extracted values fill blanks only. */
export function mergeInvoiceFields(provided = {}, extracted = {}) {
  const pick = (key) => String(provided[key] ?? '').trim() || String(extracted[key] ?? '').trim();
  return {
    invoiceNumber: pick('invoiceNumber'),
    invoiceDate: pick('invoiceDate'),
    vendor: pick('vendor'),
    amount: pick('amount')
  };
}

function extractInvoiceNumber(lines, joined) {
  for (const line of lines) {
    let m = line.match(/factur[aă]\s+(?:fiscal[aă]\s+)?(?:seria?\s+([A-Z]{2,12})\s+)?nr\.?\s*:?\s*([A-Z0-9][A-Z0-9\-/]*)/i);
    if (m) return `${m[1] || ''}${m[2] || ''}`.trim();

    m = line.match(/(?:seria|serie)\s+([A-Z]{2,12})\s+nr\.?\s*(\d+)/i);
    if (m) return `${m[1]}${m[2]}`;

    m = line.match(/factur[aă]\s+fiscal[aă]\s+([A-Z]{2,12}\d+)/i);
    if (m) return m[1];

    m = line.match(/rechn\.-?\s*nr\.?\s*:?\s*([A-Z0-9\-]+)/i);
    if (m) return m[1];

    m = line.match(/\b(FCHR\d+)\b/i);
    if (m) return m[1];

    m = line.match(/nr\.?\s*:?\s*(AI-\d+)/i);
    if (m) return m[1];

    m = line.match(/nr\.?\s*:?\s*AI-?(\d{3,6})/i);
    if (m) return `AI-${m[1]}`;
  }

  const inline = joined.match(/factur[aă][^0-9]{0,20}(FCHR\d+)/i);
  if (inline) return inline[1];

  return '';
}

function extractInvoiceDate(lines) {
  for (const line of lines) {
    if (/scadent|scadență|fällig|due\s+date/i.test(line)) continue;

    const labeled = line.match(/(?:data|datum|din\s+data)[^0-9]{0,24}(\d{1,2}[./]\d{1,2}[./]\d{4})/i);
    if (labeled) {
      const iso = normalizeImportDate(labeled[1]);
      if (iso) return iso;
    }
  }
  return '';
}

function extractVendor(lines, joined) {
  for (const { re, label } of KNOWN_VENDORS) {
    if (re.test(joined)) return label;
  }

  for (const line of lines) {
    const m = line.match(/furnizor\s*:?\s*(.+?)(?:\s+beneficiar\s*:|$)/i);
    if (m) {
      const name = cleanVendorName(m[1]);
      if (name.length > 2) return name;
    }
    const m2 = line.match(/vanzator\s*:?\s*(.+)$/i);
    if (m2) {
      const name = cleanVendorName(m2[1]);
      if (name.length > 2) return name;
    }
  }

  const srl = joined.match(/([A-Z][A-Za-z0-9\s.&-]{2,40}?\s+S\.?\s*R\.?\s*L\.?)/);
  if (srl && /chrome|fks|altex|flanco|garage|computers/i.test(srl[1])) {
    return cleanVendorName(srl[1]);
  }

  return '';
}

function extractInvoiceAmount(lines, joined) {
  const patterns = [
    /total\s+de\s+plat[aă]\s*:?\s*(?:ron|eur|lei)?\s*([\d][\d.,]*)/i,
    /gesamtbetrag\s*:?\s*(?:eur\s*)?([\d][\d.,]*)/i,
    /bruttobetrag\s*:?\s*(?:eur\s*)?([\d][\d.,]*)/i,
    /(?:^|\s)total\s*:?\s*(?:ron|eur|lei)?\s*([\d][\d.,]*)/i
  ];

  let best = 0;
  let suffix = joined.match(/\bron\b|\blei\b/i) ? ' RON' : (joined.match(/\beur\b/i) ? ' EUR' : '');

  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m) best = Math.max(best, parseAmountValue(m[1]));
    }
  }

  if (best > 0) return formatAmount(String(best), suffix);
  return '';
}

function cleanVendorName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*(cif|cui|j\d+|ro\d+).*$/i, '')
    .trim()
    .slice(0, 80);
}

function parseAmountValue(raw) {
  let n = String(raw ?? '').trim();
  if (!n) return 0;
  if (n.includes(',') && n.includes('.')) {
    if (n.lastIndexOf(',') > n.lastIndexOf('.')) {
      n = n.replace(/\./g, '').replace(',', '.');
    } else {
      n = n.replace(/,/g, '');
    }
  } else if (n.includes(',')) {
    n = n.replace(',', '.');
  }
  const num = Number(n);
  return Number.isNaN(num) ? 0 : num;
}

function formatAmount(raw, suffix = '') {
  const num = parseAmountValue(raw);
  if (!num) return '';
  const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return formatted + suffix;
}
