import { extractLenovoMtmCode } from './lenovo-mtm-map.js';

/**
 * Vendor-specific invoice template parsers.
 *
 * Each template has:
 *   id         – unique short name shown in the UI dropdown
 *   label      – human-readable name for the UI
 *   detect(lines) – returns true when this template matches the invoice
 *   parse(lines)  – returns an array of { serial, modelText, qty, assetTag }
 *
 * A "generic" fallback template is always available and uses broad heuristics.
 *
 * Serial patterns used across templates:
 *   Lenovo:   8-char alphanumeric, starts with 2 letters (e.g. PF631E3Z)
 *   iPhone:   12–15 upper-case alphanumeric (e.g. M0YJXF66KY3F)
 *   Samsung:  15-digit IMEI or 11-char serial
 *   Generic:  any token 8-20 chars matching /^[A-Z0-9]{8,20}$/
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SERIAL_RE = /\b([A-Z0-9]{8,20})\b/g;

function extractSerials(text) {
  const serials = [];
  let m;
  const re = new RegExp(SERIAL_RE.source, 'g');
  while ((m = re.exec(text)) !== null) serials.push(m[1]);
  return serials;
}

function lineContainsSerial(line) {
  return SERIAL_RE.test(line.toUpperCase());
}

/**
 * Join consecutive non-empty lines into paragraphs for easier parsing.
 */
function joinContext(lines, idx, before = 2, after = 2) {
  return lines.slice(Math.max(0, idx - before), idx + after + 1).join(' ');
}

// ---------------------------------------------------------------------------
// Template: Altex / eMag style (Romanian e-commerce + B2B invoices)
// Typical layout:
//   <product row>  <model name> ... S/N: XXXXXXXX   Qty: N
// ---------------------------------------------------------------------------
const altex = {
  id: 'altex',
  label: 'Altex / eMAG',
  detect(lines) {
    const joined = lines.join(' ').toLowerCase();
    return joined.includes('altex') || joined.includes('emag') || joined.includes('s/n:');
  },
  parse(lines) {
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const upper = line.toUpperCase();

      // Look for explicit S/N: / SN: / Serie: / Nr. serie: / Serial: markers
      const snMatch = upper.match(/(?:S\/N|SN|SERIE|NR\.?\s*SERIE|SERIAL\s*(?:NUMBER)?)\s*:?\s*([A-Z0-9]{8,20})/);
      if (snMatch) {
        const serial = snMatch[1];
        const ctx = joinContext(lines, i, 3, 1);
        const modelText = inferModelText(ctx, serial);
        const qty = extractQty(ctx);
        rows.push({ serial, modelText, qty, assetTag: '' });
      }
    }
    return rows;
  }
};

// ---------------------------------------------------------------------------
// Template: Generic supplier (no known vendor header, but has SN/serial patterns)
// Falls back to broad regex extraction.
// ---------------------------------------------------------------------------
const generic = {
  id: 'generic',
  label: 'Generic (auto-detect serial)',
  detect(_lines) {
    return true; // always matches as fallback
  },
  parse(lines) {
    const rows = [];
    const seen = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const upper = line.toUpperCase();

      // Prefer explicit serial markers first (catches Serie:, S/N:, Serial:)
      const explicitMatch = upper.match(/(?:S\/N|SN|SERIE|NR\.?\s*SERIE|SERIAL\s*(?:NUMBER)?)\s*:?\s*([A-Z0-9]{8,20})/);
      if (explicitMatch) {
        const serial = explicitMatch[1];
        if (!seen.has(serial)) {
          seen.add(serial);
          const ctx = joinContext(lines, i, 3, 1);
          rows.push({ serial, modelText: inferModelText(ctx, serial), qty: extractQty(ctx), assetTag: '' });
        }
        continue;
      }

      if (!lineContainsSerial(upper)) continue;

      const serials = extractSerials(upper);
      for (const serial of serials) {
        if (seen.has(serial)) continue;
        if (/^\d+$/.test(serial)) continue;  // pure numbers
        if (serial.length < 8) continue;
        seen.add(serial);

        const ctx = joinContext(lines, i, 3, 1);
        const modelText = inferModelText(ctx, serial);
        const qty = extractQty(ctx);
        rows.push({ serial, modelText, qty, assetTag: '' });
      }
    }
    return rows;
  }
};

// ---------------------------------------------------------------------------
// FKS IT GmbH helpers — PDFs often extract table columns as separate lines
// ---------------------------------------------------------------------------
const FKS_HEADER_NOISE = /rechn\.-?nr|kunden-?nr|datum|fällig|ust-?id|lieferanschrift|nettobetrag|bruttobetrag|gesamtbetrag|mwst|pos\.\s*art/i;
const FKS_ADDRESS_NOISE = /s\.?\s*r\.?\s*l|gmbh|business\s+garden|bucuresti|bucharest|rumänien|romania|calea|plevnei|lieferadresse|straße|strasse|untergeschoss|restaurant|tchibo|brands\s+s/i;
const FKS_PRODUCT_HINT = /lenovo|thinkpad|thinkbook|thinkvision|macbook|iphone|ipad|samsung|surface|dell|hp\s|nb\s+tp|ideapad|yoga|latitude|precision|monitor|notebook/i;
const FKS_ART_NR_ONLY = /^(?:\d+\s+)?([0-9]{2}[A-Z0-9]{6,}(?:H|EU)?|[A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9]{4,})$/i;

/** Art.-Nr. from FKS invoices: Lenovo MTM (21RLS5FP0H) or monitor codes (64AAGAT2EU). */
function extractFksArtNr(line) {
  const lenovo = extractLenovoMtmCode(line);
  if (lenovo) return lenovo;
  const t = String(line ?? '').trim().toUpperCase();
  const only = t.match(/^(?:\d+\s+)?([0-9]{2}[A-Z0-9]{6,}(?:H|EU)?)$/);
  if (only && !/^99-11/.test(only[1])) return only[1];
  const inline = t.match(/^(?:\d+\s+)?([0-9]{2}[A-Z0-9]{6,}(?:H|EU)?)\s+/);
  if (inline && !/^99-11/.test(inline[1])) return inline[1];
  return '';
}

function isFksAddressLine(line) {
  return FKS_ADDRESS_NOISE.test(line);
}

function isFksNoiseLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (FKS_HEADER_NOISE.test(t)) return true;
  if (isFksAddressLine(t)) return true;
  if (/^SN:/i.test(t)) return true;
  if (/^art\.-?nr/i.test(t)) return true;
  if (/keyboard|operation system|polish|english\s*\(|ship by cost|lieferung\s+ls\//i.test(t)) return true;
  if (/^\d+\s+st[üu]ck\b/i.test(t)) return true;
  if (/^99-11-00000$/i.test(t)) return true;
  return false;
}

function isFksProductLine(line) {
  const t = line.trim();
  if (!t || t.length < 8 || isFksNoiseLine(t)) return false;
  return FKS_PRODUCT_HINT.test(t);
}

function scoreFksModelCandidate(text) {
  if (!text || isFksAddressLine(text)) return -100;
  let score = 0;
  if (FKS_PRODUCT_HINT.test(text)) score += 10;
  if (/\b\d+\s*G\b|\b16G\b|\b1T\b|\b11P\b|\bU[57]\b/i.test(text)) score += 5;
  if (/2-in-1|gen\s*\d|thinkpad|thinkvision|t14|t27|x13/i.test(text)) score += 3;
  return score;
}

function pickFksModelText(modelLines) {
  let best = { text: '', score: -1 };
  for (const line of modelLines) {
    const score = scoreFksModelCandidate(line);
    if (score > best.score) best = { text: line, score };
  }
  return best.score > 0 ? best.text : (modelLines[0] || '');
}

function isFksBlockHeader(line, artNr, split) {
  if (!artNr) return false;
  if (FKS_ART_NR_ONLY.test(line)) return true;
  if (split.artNr && (split.modelText || FKS_PRODUCT_HINT.test(line))) return true;
  return new RegExp(`^(?:\\d+\\s+)?${artNr}\\b`, 'i').test(line);
}

/** Group lines into product blocks so each SN keeps its own Art.-Nr. and description. */
function parseFksBlocks(lines) {
  const rows = [];
  let block = null;

  const emitBlock = () => {
    if (!block || block.serials.length === 0) return;
    const modelText = pickFksModelText(block.modelLines);
    for (const serial of block.serials) {
      rows.push({ serial, artNr: block.artNr, modelText, qty: 1, assetTag: '' });
    }
  };

  const beginBlock = (artNr, modelLine) => {
    emitBlock();
    block = { artNr, modelLines: modelLine ? [modelLine] : [], serials: [] };
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;

    const snMatch = t.match(/^SN:\s*([A-Z0-9]{6,20})$/i);
    if (snMatch) {
      if (!block) block = { artNr: '', modelLines: [], serials: [] };
      block.serials.push(snMatch[1]);
      continue;
    }

    if (/^lieferung\s+ls\//i.test(t)) continue;
    if (isFksNoiseLine(t) && !FKS_PRODUCT_HINT.test(t)) continue;

    const split = splitFksGluedLine(t);
    const artNr = split.artNr || extractFksArtNr(t);

    if (artNr && isFksBlockHeader(t, artNr, split)) {
      const modelLine = split.modelText || (FKS_PRODUCT_HINT.test(t) ? cleanFksModelLine(t) : '');
      beginBlock(artNr, modelLine);
      continue;
    }

    if (block && (isFksProductLine(t) || /thinkvision|monitor/i.test(t))) {
      block.modelLines.push(cleanFksModelLine(t));
    }
  }

  emitBlock();
  return rows;
}

function cleanFksModelLine(line) {
  return line
    .replace(/^(?:\d+\s+)?[0-9]{2}[A-Z0-9]{6,}(?:H|EU)?\s*/i, '')
    .replace(/^LENOVO\s*/i, 'Lenovo ')
    .replace(/\s*\d+\s*St[üu]ck\b.*/i, '')
    .replace(/\s*\d{1,4}[.,]\d{2}(\s+\d{1,4}[.,]\d{2})?\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Split PDF-glued product lines like "221Q1S2770HLENOVO NB TP X1…". */
function splitFksGluedLine(line) {
  const artNr = extractFksArtNr(line);
  let modelText = line.trim();
  if (artNr) {
    const upper = line.toUpperCase();
    const idx = upper.indexOf(artNr);
    if (idx >= 0) {
      modelText = line.slice(idx + artNr.length);
    } else {
      modelText = line.replace(new RegExp(`^[0-9]?${artNr}`, 'i'), '');
    }
    if (/^LENOVO/i.test(modelText)) modelText = `Lenovo ${modelText.slice(6).trim()}`;
  } else if (/^NB\s+TP/i.test(modelText)) {
    modelText = `Lenovo ${modelText}`;
  }
  return { artNr, modelText: cleanFksModelLine(modelText) };
}

function extractFksQtyNear(lines, snIndex) {
  const window = lines.slice(Math.max(0, snIndex - 5), snIndex + 3).join(' ');
  const m = window.match(/(\d+)\s*St[üu]ck/i);
  return m ? parseInt(m[1], 10) : 1;
}

// ---------------------------------------------------------------------------
// Template: FKS IT GmbH (German IT supplier invoicing Romanian companies)
// ---------------------------------------------------------------------------
const fks = {
  id: 'fks',
  label: 'FKS',
  detect(lines) {
    const joined = lines.join(' ').toLowerCase();
    if (joined.includes('fks') && (joined.includes('rechnung') || joined.includes('fks-it'))) return true;
    if (/rechnung/.test(joined) && lines.some((l) => /^SN:\s*[A-Z0-9]/i.test(l.trim()))) return true;
    if (/art\.-?nr|artikel-bezeichnung/.test(joined) && lines.some((l) => /^SN:\s*[A-Z0-9]/i.test(l.trim()))) return true;
    return false;
  },
  parse(lines) {
    const blockRows = parseFksBlocks(lines);
    if (blockRows.length) return blockRows;

    const rows = [];
    const seen = new Set();

    const artNrRe = /^(?:\d+\s+)?([0-9]{2}[A-Z0-9]{6,}H?|[A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9]{4,})\s+(.+)$/i;
    for (let i = 0; i < lines.length; i++) {
      const m = artNrRe.exec(lines[i].trim());
      if (!m || /ship|versand/i.test(m[2])) continue;
      const block = lines.slice(i, i + 8).join('\n');
      const snInBlock = block.match(/^SN:\s*([A-Z0-9]{6,20})$/im);
      if (!snInBlock) continue;
      const serial = snInBlock[1];
      if (seen.has(serial)) continue;
      seen.add(serial);
      rows.push({
        serial,
        artNr: m[1].toUpperCase(),
        modelText: cleanFksModelLine(m[2]),
        qty: extractFksQtyNear(lines, i),
        assetTag: ''
      });
    }

    return rows;
  }
};

// ---------------------------------------------------------------------------
// Chrome Computers (Romanian supplier — MacBook invoices & warranty certs)
// Invoice:
//   Z1FB001LB Laptop APPLE MacBook MacBook Pro 14.2", Apple M4 Pro ...
//   S/n: SJY10V2G7N4 , SHDJVWQV6NL , ...
// Warranty certificate (one row per device):
//   1 MW0W3RO/A MW0W3RO/A Laptop Apple MacBook Air 13", Apple M4 ... SMWL5F972HG 36
// ---------------------------------------------------------------------------
const CHROME_SN_LINE = /^S\/n\s*:?\s*(.+)$/i;
const CHROME_COD = '[A-Z0-9]{4,12}(?:\\/[A-Z])?';
const CHROME_PRODUCT_LINE = new RegExp(`^(?:\\d+\\s+)?(${CHROME_COD})\\s+(.+)$`, 'i');

function parseChromeSerials(raw) {
  return String(raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{10,14}$/.test(s));
}

function cleanChromeModelText(desc) {
  let modelText = desc
    .replace(new RegExp(`^(${CHROME_COD})\\s*`, 'i'), '')
    .replace(/^Laptop\s+/i, '')
    .replace(/^APPLE\s+/i, '')
    .replace(/MacBook\s+MacBook/i, 'MacBook')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const chip = modelText.match(/^(.*?Apple\s+M\d(?:\s+Pro|\s+Max)?)/i);
  if (chip) modelText = chip[1].trim();
  const air = modelText.match(/^(.*?MacBook Air\s+\d+)/i);
  if (air && !/Apple\s+M\d/i.test(modelText)) modelText = air[1].trim();

  return modelText;
}

function parseChromeProductLine(line) {
  const m = CHROME_PRODUCT_LINE.exec(line.trim());
  if (!m) return null;
  const artNr = m[1].toUpperCase();
  let desc = m[2].trim();
  if (!/macbook|apple\s+mac/i.test(desc)) return null;

  let warrantyMonths = 0;
  const tailMonths = desc.match(/\s(\d{1,3})\s*(?:luni|months?|monate?)?\s*$/i);
  if (tailMonths) {
    warrantyMonths = parseInt(tailMonths[1], 10) || 0;
    desc = desc.replace(/\s\d{1,3}\s*(?:luni|months?|monate?)?\s*$/i, '').trim();
  }

  return { artNr, modelText: cleanChromeModelText(desc), warrantyMonths };
}

/** Warranty table: Nr | Cod | Nume produs | Serial | 36 luni */
function parseChromeWarrantyTableRow(line) {
  const t = line.trim();
  if (!/macbook/i.test(t)) return null;

  const tail = t.match(/\s([A-Z0-9]{10,14})\s+(\d{1,3})\s*$/i);
  if (!tail) return null;

  const serial = tail[1].toUpperCase();
  const head = t.slice(0, tail.index).trim().replace(/^\d+\s+/, '');
  const codMatch = head.match(new RegExp(`^(${CHROME_COD})\\s+(.+)$`, 'i'));
  if (!codMatch) return null;

  const artNr = codMatch[1].toUpperCase();
  const warrantyMonths = parseInt(tail[2], 10) || 0;
  return {
    serial,
    artNr,
    modelText: cleanChromeModelText(codMatch[2]),
    warrantyMonths
  };
}

function parseChromeWarrantyTable(lines) {
  const rows = [];
  const seen = new Set();
  for (const line of lines) {
    const row = parseChromeWarrantyTableRow(line);
    if (!row || seen.has(row.serial)) continue;
    seen.add(row.serial);
    rows.push({
      serial: row.serial,
      artNr: row.artNr,
      modelText: row.modelText,
      warrantyMonths: row.warrantyMonths,
      qty: 1,
      assetTag: ''
    });
  }
  return rows;
}

const chrome = {
  id: 'chrome',
  label: 'Chrome Computers',
  detect(lines) {
    const joined = lines.join(' ').toLowerCase();
    if (joined.includes('chrome') && joined.includes('computer')) return true;
    if (/factur[aă]\s+fiscal[aă]/.test(joined) && joined.includes('chrome') && joined.includes('macbook')) return true;
    if (joined.includes('chrome') && /certificat.*garantie|garantie.*calitate/i.test(joined)) return true;
    return false;
  },
  parse(lines) {
    const warrantyRows = parseChromeWarrantyTable(lines);
    if (warrantyRows.length) return warrantyRows;

    const rows = [];
    const seen = new Set();
    let pending = null;

    const emitSerials = (raw, product) => {
      for (const serial of parseChromeSerials(raw)) {
        if (seen.has(serial)) continue;
        seen.add(serial);
        rows.push({
          serial,
          artNr: product.artNr,
          modelText: product.modelText,
          warrantyMonths: product.warrantyMonths || 0,
          qty: 1,
          assetTag: ''
        });
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;

      const snLine = CHROME_SN_LINE.exec(t);
      if (snLine) {
        const product = pending || findChromeProductNearby(lines, i);
        if (product) emitSerials(snLine[1], product);
        pending = null;
        continue;
      }

      const product = parseChromeProductLine(t);
      if (product) {
        pending = product;
        const inline = CHROME_SN_LINE.exec(t.replace(/^[^S]*/i, '')) || t.match(/S\/n\s*:?\s*(.+)$/i);
        if (inline) {
          emitSerials(inline[1], product);
          pending = null;
        }
      }
    }

    return rows;
  }
};

function findChromeProductNearby(lines, snIndex) {
  for (let j = snIndex - 1; j >= Math.max(0, snIndex - 15); j--) {
    const product = parseChromeProductLine(lines[j].trim());
    if (product) return product;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cancom Romania — Aviz de însoțire (delivery note with Apple MacBooks)
//   Nr.: AI-7864 din data 20.01.2026
//   MX2E3RO/A MacBook Pro 14" Apple M4 Pro ... S/N: SKM77Y2D12C, SKMWT47J7NP, ...
// Word PDFs often split cod / description / S/N across separate lines (no "MacBook" in extract).
// ---------------------------------------------------------------------------
const CANCOM_APPLE_COD = '[A-Z]{2}(?=[A-Z0-9]*[0-9])[A-Z0-9]{2,7}/[A-Z]';
const CANCOM_APPLE_COD_RE = new RegExp(`\\b(${CANCOM_APPLE_COD})\\b`, 'i');

/** Known Apple order codes when description text is missing from PDF extract. */
const CANCOM_COD_LABELS = {
  'MX2E3RO/A': 'MacBook Pro 14" Apple M4 Pro',
};

function isCancomAppleSerial(token) {
  const s = String(token ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{10,14}$/.test(s)) return false;
  if (/^RO\d{4,}$/.test(s)) return false;
  if (/^\d+$/.test(s)) return false;
  if (!/[A-Z]/.test(s) || !/\d/.test(s)) return false;
  return s.startsWith('S');
}

function parseCancomSerials(raw) {
  return String(raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(isCancomAppleSerial);
}

function extractCancomAppleCod(line) {
  return line.match(CANCOM_APPLE_COD_RE)?.[1]?.toUpperCase() || '';
}

function extractCancomSnPayload(line) {
  const m = String(line ?? '').match(/S\/N\s*:?\s*(.+)$/i);
  return m ? m[1] : '';
}

function isCancomSerialContinuationLine(line) {
  const t = String(line ?? '').trim();
  if (!t || t.length > 120 || /S\/N\s*:/i.test(t)) return false;
  if (!/^[A-Z0-9][A-Z0-9,\s]+$/i.test(t)) return false;
  const parts = t.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(isCancomAppleSerial);
}

function isCancomProductCodLine(line) {
  const t = String(line ?? '').trim();
  const cod = extractCancomAppleCod(t);
  if (!cod) return false;
  return t.length <= 40 || t.replace(new RegExp(CANCOM_APPLE_COD, 'gi'), '').trim().length <= 8;
}

function cleanCancomModelText(text, cod = '') {
  let modelText = String(text ?? '')
    .split(/S\/N\s*:/i)[0]
    .replace(new RegExp(CANCOM_APPLE_COD, 'gi'), ' ')
    .replace(/^\d+\.?\s+/, '')
    .replace(/\s+\d+\s*$/g, ' ')
    .replace(/,\s*\d+GB de memorie.*/i, '')
    .replace(/Adaptor alimentare.*/i, '')
    .replace(/International layout.*/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const short = modelText.match(/^(MacBook(?:\s+Pro|\s+Air)?\s*\d*["″]?(?:\s+Apple\s+M\d(?:\s+Pro|\s+Max)?)?[^,]{0,40})/i);
  if (short) return short[1].trim();
  if (modelText.length > 3) return modelText.slice(0, 100);
  return CANCOM_COD_LABELS[cod] || (cod ? `Apple ${cod}` : '');
}

function parseCancomProductLine(line) {
  const t = line.trim();
  if (t.length > 200) return null;
  const cod = extractCancomAppleCod(t);
  if (cod && !/macbook/i.test(t) && !isCancomProductCodLine(t)) return null;
  if (!cod && !/macbook/i.test(t)) return null;

  const snMatch = t.match(/S\/N\s*:?\s*(.+)$/i);
  const artNr = cod || t.match(new RegExp(`(${CANCOM_APPLE_COD})`, 'i'))?.[1]?.toUpperCase() || '';

  return {
    artNr,
    modelText: cleanCancomModelText(t, artNr),
    serialsRaw: snMatch ? snMatch[1] : ''
  };
}

function findCancomProductNearby(lines, snIndex) {
  for (let j = snIndex - 1; j >= Math.max(0, snIndex - 25); j--) {
    const block = parseCancomProductLine(lines[j].trim());
    if (block?.artNr || block?.modelText) return block;
  }
  return null;
}

const cancom = {
  id: 'cancom',
  label: 'Cancom Romania',
  detect(lines) {
    const joined = lines.join(' ').toLowerCase();
    if (joined.includes('cancom')) return true;
    if (/aviz\s+de\s+insotire|aviz\s+de\s+însoțire/i.test(joined) && joined.includes('cancom')) return true;
    return false;
  },
  parse(lines) {
    const rows = [];
    const seen = new Set();
    let pending = null;

    const emitSerials = (raw, product) => {
      for (const serial of parseCancomSerials(raw)) {
        if (seen.has(serial)) continue;
        seen.add(serial);
        rows.push({
          serial,
          artNr: product.artNr,
          modelText: product.modelText,
          qty: 1,
          assetTag: ''
        });
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;

      const snPayload = extractCancomSnPayload(t);
      if (snPayload) {
        const product = pending || findCancomProductNearby(lines, i);
        if (product) {
          emitSerials(snPayload, product);
          pending = product;
        }
        continue;
      }

      if (pending && isCancomSerialContinuationLine(t)) {
        emitSerials(t, pending);
        continue;
      }

      const block = parseCancomProductLine(t);
      if (block) {
        if (block.serialsRaw) {
          emitSerials(block.serialsRaw, block);
          pending = null;
        } else {
          pending = block;
        }
      }
    }

    return rows;
  }
};

// ---------------------------------------------------------------------------
// Template: Flanco / PC Garage style (Romanian tech retailers)
// Typical layout: table rows with product code, description, SN, price
// ---------------------------------------------------------------------------
const flanco = {
  id: 'flanco',
  label: 'Flanco / PC Garage',
  detect(lines) {
    const joined = lines.join(' ').toLowerCase();
    return joined.includes('flanco') || joined.includes('pc garage') || joined.includes('pcgarage');
  },
  parse(lines) {
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Flanco typically writes serial as standalone token on product line
      const upper = line.toUpperCase();
      const snMatch = upper.match(/(?:SERIE|SERIAL\s*(?:NUMBER)?|S\/N)\s*:?\s*([A-Z0-9]{8,20})/);
      if (snMatch) {
        const serial = snMatch[1];
        const ctx = joinContext(lines, i, 3, 1);
        rows.push({ serial, modelText: inferModelText(ctx, serial), qty: extractQty(ctx), assetTag: '' });
      }
    }
    return rows;
  }
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a model/product name from the surrounding context lines.
 * Removes the serial itself, currency amounts, and common noise tokens.
 */
function inferModelText(ctx, serial) {
  let text = ctx
    .replace(new RegExp(serial, 'gi'), ' ')
    .replace(/(?:S\/N|SN|SERIE|NR\.?\s*SERIE|SERIAL)\s*:?\s*/gi, ' ')
    .replace(/\d{1,3}[.,]\d{2,3}([.,]\d{2})?/g, ' ')  // prices
    .replace(/(?:RON|EUR|USD|TVA|TOTAL|QTY|BUC|PCS|CANT)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Keep only the portion that looks like a product name (up to 80 chars)
  if (text.length > 80) text = text.slice(0, 80);
  return text || '';
}

function extractQty(ctx) {
  const m = ctx.match(/(?:QTY|CANT|BUC|PCS|CANTITATE)\s*:?\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Ordered list of templates; generic is always last. */
export const TEMPLATES = [fks, cancom, chrome, altex, flanco, generic];

/**
 * Auto-detect the best template for the given lines.
 * Returns the first matching template (generic always matches as fallback).
 */
export function detectTemplate(lines) {
  return TEMPLATES.find((t) => t.detect(lines)) ?? generic;
}

/**
 * Parse invoice lines with a specific template id (or auto-detect if 'auto').
 * Returns an array of { serial, modelText, qty, assetTag }.
 */
export function parseInvoiceLines(lines, templateId = 'auto') {
  const resolvedId = templateId === 'fks-it' ? 'fks' : templateId;
  const template = resolvedId === 'auto'
    ? detectTemplate(lines)
    : (TEMPLATES.find((t) => t.id === resolvedId) ?? generic);
  return { templateId: template.id, rows: template.parse(lines) };
}
