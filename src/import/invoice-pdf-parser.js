/**
 * PDF text extractor — no external dependencies.
 *
 * Supports both:
 *   - Uncompressed content streams (BT...ET blocks directly readable)
 *   - FlateDecode compressed streams (zlib / deflate — used by most modern
 *     accounting software: Saga, WinMentor, SmartBill, Facturis, Ciel, etc.)
 *
 * Does NOT handle:
 *   - Scanned / image-only PDFs (no content stream text)
 *   - LZWDecode, JBIG2, CCITT (rare in invoice PDFs)
 *   - Encrypted PDFs
 */

import { inflateSync } from 'node:zlib';

/**
 * Extract all plain-text lines from a PDF buffer.
 * Returns an array of non-empty trimmed strings.
 * @param {Buffer} buffer
 * @returns {string[]}
 */
export function extractLinesFromPdf(buffer) {
  const text = decodePdfBuffer(buffer);
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Core PDF decoder
// ---------------------------------------------------------------------------

/**
 * Decode all content streams from a PDF buffer into concatenated plain text.
 * Tries FlateDecode first, then falls back to raw text parsing.
 */
function decodePdfBuffer(buffer) {
  // Work in latin1 so byte values are preserved 1:1
  const raw = buffer.toString('latin1');
  const parts = [];

  // Regex to find each object's stream with its filter declaration
  // We look for the dictionary before the stream keyword to detect FlateDecode
  const objRe = /(?:<<([^>]*)>>[\s\S]*?)?stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = objRe.exec(raw)) !== null) {
    const dictPart = match[1] || '';
    const streamRaw = match[2];
    const isFlateDecode = /FlateDecode|Fl\b/i.test(dictPart);

    let decoded = '';
    if (isFlateDecode) {
      decoded = tryInflate(streamRaw);
    } else {
      // Try raw BT...ET extraction (uncompressed stream)
      decoded = extractBtEt(streamRaw);
    }
    if (decoded) parts.push(decoded);
  }

  // Also catch BT...ET blocks that appear directly in the file body
  // (some simple PDFs write them outside formal stream objects)
  const directText = extractBtEt(raw);
  if (directText) parts.push(directText);

  return parts.join('\n');
}

/**
 * Attempt to inflate (decompress) a FlateDecode stream.
 * Returns extracted text or empty string on failure.
 */
function tryInflate(streamData) {
  // Convert latin1 string back to binary Buffer
  const buf = Buffer.from(streamData, 'latin1');

  // Try multiple offsets: standard zlib (offset 0),
  // and raw deflate (no zlib header, offset 0 with raw inflate).
  const attempts = [
    () => inflateSync(buf),
  ];

  // Also try skipping leading garbage bytes (some PDFs have extra bytes before stream)
  for (let skip = 0; skip < Math.min(16, buf.length); skip++) {
    attempts.push(() => inflateSync(buf.subarray(skip)));
  }

  for (const attempt of attempts) {
    try {
      const inflated = attempt();
      const text = inflated.toString('latin1');
      const extracted = extractBtEt(text);
      if (extracted) return extracted;
      // Even without BT/ET, if it looks like readable text, return it
      if (/[a-zA-Z]{4,}/.test(text)) return text;
    } catch {
      // Try next offset
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// PDF content stream text parser (BT...ET operators)
// ---------------------------------------------------------------------------

/**
 * Extract readable text from a PDF content stream string.
 * Handles BT...ET blocks with Tj, TJ, ', " operators.
 */
function extractBtEt(stream) {
  const parts = [];
  const btRe = /BT\b([\s\S]*?)\bET/g;
  let m;
  while ((m = btRe.exec(stream)) !== null) {
    const t = parseTextBlock(m[1]);
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

/**
 * Parse operators inside a BT...ET block and emit text tokens.
 * Handles Tj, TJ, ' and " operators, including nested arrays.
 */
function parseTextBlock(block) {
  const tokens = [];

  // TJ operator: [(text) spacing (text) ...] TJ
  const tjRe = /\[([^\]]*)\]\s*TJ/g;
  let m;
  while ((m = tjRe.exec(block)) !== null) {
    const parts = extractPdfStringParts(m[1]);
    if (parts.length) tokens.push(parts.join(''));
  }

  // Tj / ' / " operators: (text) Tj
  const tjSingleRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")/g;
  while ((m = tjSingleRe.exec(block)) !== null) {
    const t = decodePdfString(m[1]);
    if (t.trim()) tokens.push(t);
  }

  return tokens.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Extract string values from a TJ array like (Hello) -200 (World).
 */
function extractPdfStringParts(arrayContent) {
  const parts = [];
  const re = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
  let m;
  while ((m = re.exec(arrayContent)) !== null) {
    parts.push(decodePdfString(m[1]));
  }
  return parts;
}

/**
 * Decode PDF string escapes including octal sequences.
 */
function decodePdfString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(.)/g, '$1');
}
