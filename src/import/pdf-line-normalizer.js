/**
 * Word PDFs often split tokens across lines (Nr.: / AI / - / 7864 / 20 / .01.2026).
 * Build synthetic glued lines so header/date parsers can read the document as written.
 */

/**
 * @param {string[]} lines
 * @returns {string[]} extra lines to append when scanning invoice metadata
 */
export function buildSupplementalInvoiceLines(lines) {
  const supplemental = [];

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;

    if (/^Nr\.?:?$/i.test(t) || /^Nr\.?:?\s*AI/i.test(t)) {
      supplemental.push(lines.slice(i, Math.min(i + 16, lines.length)).map((l) => l.trim()).join(''));
    }

    if (/din\s+data/i.test(t) || /\(ZZ\.LL\.AAAA\)/i.test(t)) {
      supplemental.push(lines.slice(i, Math.min(i + 12, lines.length)).map((l) => l.trim()).join(''));
    }

    if (/^datum\s*:/i.test(t) || /^rechnung/i.test(t)) {
      supplemental.push(lines.slice(i, Math.min(i + 4, lines.length)).map((l) => l.trim()).join(''));
    }

    if (/factur[aă]\s+fiscal/i.test(t)) {
      supplemental.push(lines.slice(i, Math.min(i + 6, lines.length)).map((l) => l.trim()).join(''));
    }

    if (/certificat.*garantie|garantie.*calitate/i.test(t)) {
      supplemental.push(lines.slice(i, Math.min(i + 8, lines.length)).map((l) => l.trim()).join(''));
    }
  }

  return supplemental.filter((l) => l.length >= 6);
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
export function linesForInvoiceScan(lines) {
  return [...lines, ...buildSupplementalInvoiceLines(lines)];
}
